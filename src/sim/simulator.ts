import { Agent, type AgentOptions, type Usage } from "../agent.js";
import { contextFrom } from "../checks.js";
import { resolveModel } from "../models/resolve.js";
import { ModelError, type Model, type ModelMessage } from "../models/types.js";
import type { Session } from "../session.js";
import { ToolError, type Tool } from "../tools.js";
import { applyExpected, grade, seedFor, type Grade, type StandIn } from "./grade.js";
import { loadTasks, type Task } from "./task.js";

export interface Suite {
  agent: Omit<AgentOptions, "model" | "tools" | "now" | "trace">;   // instructions, journeys, knowledge, checks…
  tools: Tool[];                                                    // the real tools: every declaration comes from here
  standIns: Record<string, StandIn>;                                // run functions by tool name, over the trial's store
  seed: unknown;
  createStore(seed: unknown, opts: { now: () => Date }): unknown;   // a fresh store per trial
  state(store: unknown): unknown | Promise<unknown>;               // what the grader compares; may read a database
  tasks: string | string[];
  agentModel: string | Model;
  customerModel: string | Model;                                    // pinned for the whole run
  prices: Record<string, { input: number; output: number }>;       // USD per million tokens, by model id
  now?: string;                                                     // fixed clock, e.g. the store's business date
}
export interface Trial {
  task: string; trial: number; status: "pass" | "fail" | "infra" | "stopped";
  ended?: "stop" | "transfer" | "out_of_scope" | "handoff" | "max_steps"; grade?: Grade; error?: string;
  turns: number; cost: number; friction?: number; tokens?: Record<"agent" | "customer", { input: number; output: number }>; transcript: { role: "customer" | "agent"; text: string }[]; events: Record<string, any>[];
}

const END = /###(STOP|TRANSFER|OUT-OF-SCOPE)###/;
const customerPrompt = (t: Task) => `You are role-playing a customer in a support chat. Stay in character.
Persona: ${t.customer.persona}
Why you're writing: ${t.customer.reason_for_call}
What you know: ${t.customer.known_info}${t.customer.unknown_info ? `\nWhat you don't know: ${t.customer.unknown_info}` : ""}
Instructions: ${t.customer.instructions}
Write only your next message: one to three short sentences, plain text. Share information only when asked or when your instructions say to. Never invent facts.
When your goal is met or you've decided to stop, reply with only ###STOP###. If you're told a person will take over, reply ###TRANSFER###. If you'd need facts you don't have, reply ###OUT-OF-SCOPE###.`;

/** Check stand-ins against the real tools and every task against the seed, before any model call. */
export async function prepare(suite: Suite, only?: string[]) {
  const names = new Set(suite.tools.map((t) => t.name));
  const unknown = Object.keys(suite.standIns).filter((n) => !names.has(n));
  const uncovered = [...names].filter((n) => !suite.standIns[n]);
  if (unknown.length || uncovered.length) throw new Error(`stand-ins don't match the tools: ${[
    ...unknown.map((n) => `stand-in "${n}" names no tool`), ...uncovered.map((n) => `tool "${n}" has no stand-in`)].join("; ")}`);
  const tasks = loadTasks(suite.tasks).filter((t) => !only || only.includes(t.id));
  for (const t of tasks) {
    const named = [...t.expect.writes.map((w) => w.tool), ...t.expect.forbidden_actions, ...t.expect.allowed_writes, ...t.inject_failures.map((f) => f.tool)];
    const bad = named.find((n) => !names.has(n));
    if (bad) throw new Error(`task ${t.id}: unknown tool "${bad}"`);
    await applyExpected(t, suite.createStore(seedFor(t, suite.seed), { now: () => new Date() }), suite.standIns);
  }
  const models = { agent: resolveModel(suite.agentModel), customer: resolveModel(suite.customerModel) };
  for (const m of Object.values(models)) if (!suite.prices[m.id]) throw new Error(`no price for model "${m.id}" in suite.prices`);
  return { tasks, models };
}

/** Run every task k times. Stops early once accumulated cost passes maxCost. */
export async function runSuite(suite: Suite, opts: { k?: number; tasks?: string[]; maxCost?: number; onTrial?: (t: Trial) => void } = {}) {
  const { tasks, models } = await prepare(suite, opts.tasks);
  const budget = { spent: 0, max: opts.maxCost ?? 5 };
  const trials: Trial[] = [];
  for (const task of tasks) for (let i = 1; i <= (opts.k ?? 1); i++) {
    const t = budget.spent > budget.max ? { task: task.id, trial: i, status: "stopped" as const, turns: 0, cost: 0, transcript: [], events: [] }
      : await runTrial(suite, task, i, models, budget);
    t.friction = t.events.filter((l) => l.type === "check" && l.result?.block).length;   // blocked drafts + actions
    trials.push(t);
    opts.onTrial?.(t);
  }
  return { trials, cost: budget.spent, stopped: budget.spent > budget.max };
}

async function runTrial(suite: Suite, task: Task, trial: number, models: { agent: Model; customer: Model }, budget: { spent: number; max: number }): Promise<Trial> {
  const now = () => new Date(suite.now ?? Date.now());
  const store = suite.createStore(seedFor(task, suite.seed), { now });
  const fail = new Map(task.inject_failures.map((f) => [f.tool, f]));
  const tools = suite.tools.map((t): Tool => ({ ...t, run: (input, ctx) => {
    const f = fail.get(t.name);
    if (f) throw new ToolError(f.code, f.message ?? `${t.name} failed.`);
    return suite.standIns[t.name](input, ctx, store) as any;
  } }));
  const events: Record<string, any>[] = [];
  const warn = console.warn;
  console.warn = () => {};                                          // startup notices once per trial would be noise
  const agent = new Agent({ ...suite.agent, model: models.agent, tools, now, trace: { write: (l) => events.push(l) } });
  console.warn = warn;

  const tokens = { agent: { input: 0, output: 0 }, customer: { input: 0, output: 0 } };
  const cost = (id: string, u?: Partial<Usage>, role: "agent" | "customer" = id === models.agent.id ? "agent" : "customer") => {
    tokens[role].input += u?.inputTokens ?? 0;
    tokens[role].output += u?.outputTokens ?? 0;
    const p = suite.prices[id], c = ((u?.inputTokens ?? 0) * p.input + (u?.outputTokens ?? 0) * p.output) / 1e6;
    budget.spent += c;
    return c;
  };
  const r: Trial = { task: task.id, trial, status: "fail", turns: 0, cost: 0, tokens, transcript: [], events };
  const convo: ModelMessage[] = [{ role: "user", content: "(The support chat is open. Write your first message.)" }];
  let session: Session | null = null, handedOff = false;
  try {
    for (; r.turns < task.max_steps && !r.ended; r.turns++) {
      const said = await models.customer.generate({ system: customerPrompt(task), messages: convo, tools: [] });
      r.cost += cost(models.customer.id, said.usage, "customer");
      const end = END.exec(said.text);
      const text = said.text.replace(END, "").trim();
      if (end && !text) { r.ended = end[1].toLowerCase().replace(/-/g, "_") as Trial["ended"]; break; }
      convo.push({ role: "assistant", content: text });
      r.transcript.push({ role: "customer", text });
      const res = await agent.respond(session, text);
      r.cost += cost(models.agent.id, res.usage, "agent");
      session = res.session;
      r.transcript.push({ role: "agent", text: res.reply });
      convo.push({ role: "user", content: res.reply });
      if (res.handoff) { handedOff = true; r.ended = "handoff"; }
      if (budget.spent > budget.max) return { ...r, status: "stopped", error: `cost limit $${budget.max} reached` };
    }
  } catch (e) {
    if (e instanceof ModelError) return { ...r, status: "infra", error: e.message };
    throw e;
  }
  r.ended ??= "max_steps";
  const gold = suite.createStore(seedFor(task, suite.seed), { now });
  await applyExpected(task, gold, suite.standIns);
  for (const r of (session?.results ?? []).filter((x) => x.ok && task.expect.allowed_writes.includes(x.tool)))
    await suite.standIns[r.tool](r.input, { facts: {}, commitments: [] }, gold);     // allowed extras don't count against the state
  const s = session ?? { messages: [], results: [], commitments: [], facts: {}, failures: 0 } as unknown as Session;
  r.grade = grade(task, {
    live: await suite.state(store), gold: await suite.state(gold), results: s.results, handedOff,
    blocked: events.filter((l) => l.type === "check" && l.event === "action").map((l) => l.tool),
    sent: s.messages.filter((m) => m.role === "agent").map((m) => m.text),
    sentCtx: s.messages.flatMap((m, i) => m.role !== "agent" ? [] : [contextFrom({ ...s, messages: s.messages.slice(0, i),
      results: s.results.filter((x) => x.turn <= m.turn), commitments: s.commitments.filter((k) => k.turn <= m.turn) }, suite.tools, agent.operatorText, now())]),
    writes: new Set(suite.tools.filter((t) => t.kind === "write").map((t) => t.name)),
  });
  r.status = r.grade.pass && r.ended !== "max_steps" ? "pass" : "fail";
  return r;
}
