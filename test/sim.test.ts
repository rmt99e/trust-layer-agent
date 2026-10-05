import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, createSession, ModelError, read, ToolError, write, z } from "../src/index.js";
import { canonical, grade, type Observed } from "../src/sim/grade.js";
import { prepare, runSuite, type Suite } from "../src/sim/simulator.js";
import { loadTasks } from "../src/sim/task.js";
import { scripted, type Step } from "./fake-model.js";
import { ctx } from "./fixtures.js";

// A tiny domain: one account, a balance, a "set_plan" write.
const SEED = { accounts: { a1: { plan: "basic", price: 9 } } };
const makeStore = (seed: any) => ({ db: structuredClone(seed) });
const tools = [
  read({ name: "get_plan", description: "Plan.", input: z.object({ id: z.string() }), visible: ["plan", "price"], run: () => ({}) }),
  write({ name: "set_plan", description: "Set plan.", input: z.object({ id: z.string(), plan: z.string() }), confirm: false, run: () => ({}) }),
];
const standIns: Suite["standIns"] = {
  get_plan: ({ id }, _c, s) => s.db.accounts[id],
  set_plan: ({ id, plan }, _c, s) => {
    if (!s.db.accounts[id]) throw new ToolError("not_found", "No such account.");
    s.db.accounts[id].plan = plan;
    return { ok: true, plan };
  },
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tla-sim-")); vi.spyOn(console, "warn").mockImplementation(() => {}); });
const task = (id: string, body: string) => writeFileSync(join(dir, `${id}.yaml`), `id: ${id}\npurpose: test\ncustomer:\n  persona: p\n  reason_for_call: r\n  known_info: k\n  instructions: i\n${body}`);
const suite = (agent: Step[], customer: Step[], over: Partial<Suite> = {}): Suite => ({
  agent: { instructions: "Help." }, tools, standIns, seed: SEED, createStore: makeStore, state: (s: any) => s.db, tasks: dir,
  agentModel: scripted(agent, { id: "fake:agent" }), customerModel: scripted(customer, { id: "fake:customer" }),
  prices: { "fake:agent": { input: 1, output: 1 }, "fake:customer": { input: 1, output: 1 } }, now: "2026-10-03T12:00:00Z", ...over,
});

const observed = ({ ctx: c = ctx(), ...o }: Partial<Observed> & { ctx?: ReturnType<typeof ctx> } = {}): Observed => ({ live: SEED, gold: SEED,
  results: [], blocked: [], handedOff: false, sent: [], writes: new Set(["set_plan"]), ...o, sentCtx: o.sentCtx ?? (o.sent ?? []).map(() => c) });
const okCall = (tool: string, input: any, output: any = {}) => ({ id: "c", tool, turn: 1, ok: true, input, output });

describe("grader", () => {
  const t = (expect: string) => { task("t", `expect:\n${expect}`); return loadTasks(dir)[0]; };

  it("state: compares canonical final state and checks expected writes ran", () => {
    const tk = t("  writes:\n    - { tool: set_plan, input: { id: a1, plan: plus }, compare: [plan] }");
    const moved = { accounts: { a1: { price: 9.0, plan: "plus" } } };
    expect(canonical(moved)).toBe(canonical({ accounts: { a1: { plan: "plus", price: 9 } } }));
    expect(grade(tk, observed({ live: moved, gold: moved, results: [okCall("set_plan", { id: "a1", plan: "plus" })] })).state.pass).toBe(true);
    expect(grade(tk, observed({ live: SEED, gold: moved })).state).toMatchObject({ pass: false, detail: expect.stringContaining("final state differs") });
    expect(grade(tk, observed({ live: moved, gold: moved })).state).toMatchObject({ pass: false, detail: "expected write not executed: set_plan" });
  });

  it("forbidden: executed fails, a blocked attempt is recorded but passes", () => {
    const tk = t("  forbidden_actions: [set_plan]");
    expect(grade(tk, observed({ blocked: ["set_plan"] })).forbidden).toEqual({ pass: true, detail: "blocked attempts: set_plan" });
    expect(grade(tk, observed({ results: [okCall("set_plan", {})] })).forbidden).toEqual({ pass: false, detail: "executed: set_plan" });
  });

  it("handoff: must match must_handoff", () => {
    const tk = t("  must_handoff: true");
    expect(grade(tk, observed({ handedOff: true })).handoff.pass).toBe(true);
    expect(grade(tk, observed()).handoff.pass).toBe(false);
  });

  it("claims: required claims must appear in sent replies, after normalization; unbacked claims fail", () => {
    const tk = t("  required_claims: [ { kind: price, value: 1019.9 }, { kind: date, value: 2026-11-01 } ]");
    const c = ctx({ results: [okCall("get_plan", {}, { price: 1019.9, starts: "2026-11-01" })] });
    expect(grade(tk, observed({ ctx: c, sent: ["It's $1,019.90 a month from November 1, 2026."] })).claims.pass).toBe(true);
    expect(grade(tk, observed({ ctx: c, sent: ["It's $1,019.90 a month."] })).claims).toMatchObject({ pass: false, detail: "not said: date 2026-11-01" });
    expect(grade(t("  {}"), observed({ ctx: c, sent: ["It's $5."] })).claims).toMatchObject({ pass: false, detail: expect.stringContaining("Reply states the amount 5") });
  });
});

describe("grader timing and async state", () => {
  it("judges each reply against the session as it was when it was sent", async () => {
    task("timing", "expect: {}");
    // The agent says "$9" before any tool returned it, then looks it up. Graded at send time, that's unbacked.
    const s = suite(["It's $9.", { call: "get_plan", input: { id: "a1" } }, "Confirmed: basic at $9."], ["How much?", "Check please.", "###STOP###"],
      { agent: { instructions: "Help.", builtins: { no_unconfirmed_claims: false } } });   // let the early "$9" through at runtime
    const { trials } = await runSuite(s, { tasks: ["timing"] });
    expect(trials[0].grade!.claims).toMatchObject({ pass: false, detail: expect.stringContaining("Reply states the amount 9") });
  });
  it("awaits an async createStore() (e.g. a database-backed store)", async () => {
    task("asyncstore", "expect:\n  writes:\n    - { tool: set_plan, input: { id: a1, plan: plus }, compare: [plan] }");
    const s = suite([{ call: "set_plan", input: { id: "a1", plan: "plus" } }, "Done, you're on plus."], ["Move me to plus, yes.", "###STOP###"],
      { createStore: async (seed: any) => { await new Promise((r) => setTimeout(r, 5)); return makeStore(seed); } });
    const { trials } = await runSuite(s, { tasks: ["asyncstore"] });
    expect(trials[0]).toMatchObject({ status: "pass" });
    expect(trials[0].grade!.state).toMatchObject({ pass: true, detail: "matches" });
  });
  it("defaults the cost cap to $10, like the CLI", async () => {
    task("cap", "expect: {}");
    const pricey = scripted(["hi", "###STOP###"], { id: "fake:customer", usage: { inputTokens: 1_000_000, outputTokens: 0 } });   // $1 per call
    const run = await runSuite(suite(["ok"], [], { customerModel: pricey }), { tasks: ["cap"] });
    expect(run.stopped).toBe(false);                                  // $2 < $10 (the old default of $5 would also pass; see next)
    const many = scripted(Array(12).fill("hi"), { id: "fake:customer", usage: { inputTokens: 1_000_000, outputTokens: 0 } });
    const run2 = await runSuite(suite(Array(12).fill("ok"), [], { customerModel: many }), { tasks: ["cap"] });
    expect(run2.cost).toBeGreaterThan(5);                             // would have stopped at $5 before
    expect(run2.cost).toBeLessThan(12);
  });

  it("awaits an async state() (e.g. a database read)", async () => {
    task("async", "expect:\n  writes:\n    - { tool: set_plan, input: { id: a1, plan: plus }, compare: [plan] }");
    const s = suite([{ call: "set_plan", input: { id: "a1", plan: "plus" } }, "Done, you're on plus."], ["Move me to plus, yes.", "###STOP###"],
      { state: async (st: any) => { await new Promise((r) => setTimeout(r, 5)); return st.db; } });
    const { trials } = await runSuite(s, { tasks: ["async"] });
    expect(trials[0].grade!.state).toMatchObject({ pass: true, detail: "matches" });
  });
});

describe("grader: forbidden phrases, done claims and allow_error", () => {
  const t = (expect: string) => { task("t", `expect:\n${expect}`); return loadTasks(dir)[0]; };
  it("fails on a forbidden phrase, case-insensitively", () => {
    const tk = t('  forbidden_phrases: ["full refund"]');
    expect(grade(tk, observed({ sent: ["Your Full Refund is on its way."] })).claims).toMatchObject({ pass: false, detail: 'said forbidden: "full refund"' });
    expect(grade(tk, observed({ sent: ["You got a partial refund."] })).claims.pass).toBe(true);
  });
  it("fails on a done claim when must_not_claim_done is set", () => {
    const tk = t("  must_not_claim_done: true");
    expect(grade(tk, observed({ sent: ["You're now on Plus."] })).claims).toMatchObject({ pass: false, detail: expect.stringContaining("a done claim") });
    expect(grade(tk, observed({ sent: ["It's submitted and pending; not done yet."] })).claims.pass).toBe(true);
  });
  it("lets an expected step end in its allowed error, and doesn't require it to have succeeded", async () => {
    task("timeout", "expect:\n  writes:\n    - { tool: set_plan, input: { id: a1, plan: plus }, allow_error: timeout }");
    const timeoutStandIns = { ...standIns, set_plan: (i: any, c: any, st: any) => { standIns.set_plan(i, c, st); throw new ToolError("timeout", "No response."); } };
    await expect(prepare(suite([], [], { standIns: timeoutStandIns }))).resolves.toBeTruthy();
    task("timeout", "expect:\n  writes:\n    - { tool: set_plan, input: { id: a1, plan: plus }, allow_error: other }");
    await expect(prepare(suite([], [], { standIns: timeoutStandIns }))).rejects.toThrow(/fails on the seed: No response/);
  });
});

describe("allowed_writes", () => {
  it("replays allowed extra writes into the expected state", async () => {
    task("extra", "expect:\n  allowed_writes: [ set_plan ]");
    const s = suite([{ call: "set_plan", input: { id: "a1", plan: "plus" } }, "Done, you're on plus."], ["Move me to plus, yes.", "###STOP###"]);
    expect((await runSuite(s, { tasks: ["extra"] })).trials[0].grade!.state).toMatchObject({ pass: true });
    task("noextra", "expect: {}");
    const s2 = suite([{ call: "set_plan", input: { id: "a1", plan: "plus" } }, "Done, you're on plus."], ["Move me to plus, yes.", "###STOP###"]);
    expect((await runSuite(s2, { tasks: ["noextra"] })).trials[0].grade!.state.pass).toBe(false);
  });
});

describe("runSuite", () => {
  it("runs a trial end to end and passes it", async () => {
    task("switch", "expect:\n  writes:\n    - { tool: set_plan, input: { id: a1, plan: plus }, compare: [plan] }\n  required_claims: [ { kind: price, value: 9 } ]");
    const s = suite([{ call: "get_plan", input: { id: "a1" } }, "You're on basic at $9.", { call: "set_plan", input: { id: "a1", plan: "plus" } }, "Switched."],
      ["What plan am I on?", "Move me to plus please.", "###STOP###"]);
    const { trials } = await runSuite(s);
    expect(trials[0]).toMatchObject({ status: "pass", ended: "stop", turns: 2 });
    expect(trials[0].transcript.map((m) => m.text)).toEqual(["What plan am I on?", "You're on basic at $9.", "Move me to plus please.", "Switched."]);
  });

  it("reports infra errors separately, never as a fail", async () => {
    task("t", "expect: {}");
    const s = suite([], ["hello"], { agentModel: scripted([], { id: "fake:agent", fail: new ModelError("anthropic 529: overloaded", 529) }) });
    const { trials } = await runSuite(s);
    expect(trials[0]).toMatchObject({ status: "infra", error: "anthropic 529: overloaded" });
    expect(trials[0].grade).toBeUndefined();
  });

  it("ends at max_steps as a fail", async () => {
    task("t", "expect: {}\nmax_steps: 2");
    const { trials } = await runSuite(suite(["ok", "ok"], ["hi", "hi again"]));
    expect(trials[0]).toMatchObject({ status: "fail", ended: "max_steps", turns: 2 });
  });

  it("stops at the cost limit", async () => {
    task("a", "expect: {}"); task("b", "expect: {}");
    const s = suite(["ok", "ok"], ["hi", "###STOP###", "hi", "###STOP###"], {
      customerModel: scripted(["hi", "###STOP###", "hi", "###STOP###"], { id: "fake:customer", usage: { inputTokens: 1_000_000, outputTokens: 0 } }) });
    const run = await runSuite(s, { maxCost: 0.5 });
    expect(run.stopped).toBe(true);
    expect(run.trials.map((t) => t.status)).toEqual(["stopped", "stopped"]);
    expect(run.cost).toBeGreaterThan(0.5);
  });
});

describe("validation before any model call", () => {
  it("catches a broken expected write, naming the task", async () => {
    task("broken", "expect:\n  writes:\n    - { tool: set_plan, input: { id: nope, plan: plus } }");
    const s = suite([], []);
    await expect(prepare(s)).rejects.toThrow("task broken: expect.writes[0] set_plan fails on the seed: No such account.");
    expect((s.agentModel as any).requests).toHaveLength(0);
  });
  it("rejects stand-ins that don't match the tools", async () => {
    task("t", "expect: {}");
    await expect(prepare(suite([], [], { standIns: { get_plan: standIns.get_plan, set_plann: standIns.set_plan } })))
      .rejects.toThrow(`stand-ins don't match the tools: stand-in "set_plann" names no tool; tool "set_plan" has no stand-in`);
  });
  it("rejects tasks naming unknown tools and models without prices", async () => {
    task("t", "expect:\n  forbidden_actions: [delete_everything]");
    await expect(prepare(suite([], []))).rejects.toThrow(`task t: unknown tool "delete_everything"`);
    task("t", "expect: {}");
    await expect(prepare(suite([], [], { prices: {} }))).rejects.toThrow(`no price for model "fake:agent"`);
  });
});

describe("injectable clock", () => {
  it("quote expiry uses the agent's clock", async () => {
    const change = write({ name: "change_plan", description: "Apply a quote.", input: z.object({ quoteId: z.string() }),
      confirm: { commitment: "quote", by: "quoteId" }, run: () => ({ status: "active" }) });
    const session = { ...createSession({ facts: { verified: true } }),
      messages: [{ role: "customer" as const, text: "switch me", turn: 1 }, { role: "agent" as const, text: "It's $29. OK?", turn: 1 }],
      commitments: [{ type: "quote", id: "q_1", by: "quote_plan_change", values: { monthlyPrice: 29 }, turn: 1, shownTurn: 1,
        status: "open" as const, expiresAt: "2026-10-04T00:00:00Z" }] };
    const run = async (now: string) => {
      const model = scripted([{ call: "change_plan", input: { quoteId: "q_1" } }, "Done."]);
      const agent = new Agent({ model, instructions: "x", tools: [change], trace: false, now: () => new Date(now) });
      await agent.respond(session, "yes");
      return model.requests[1].messages.at(-1)!.content;
    };
    expect(await run("2026-10-03T12:00:00Z")).toContain("<tool_result>");
    expect(await run("2026-10-05T12:00:00Z")).toContain("has expired");
  });
});
