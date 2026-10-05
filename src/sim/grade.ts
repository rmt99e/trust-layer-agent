// Deterministic grading: final data state, forbidden actions, handoff, claims. No LLM judge.
import type { CheckContext } from "../checks.js";
import { extractClaims, normNumber, unconfirmed } from "../claims.js";
import type { Json, ToolResult } from "../session.js";
import type { Task } from "./task.js";

export type StandIn = (input: any, ctx: { facts: Record<string, Json>; commitments: readonly unknown[] }, store: any) => unknown;
export interface Component { pass: boolean; detail: string }
export interface Grade { pass: boolean; state: Component; forbidden: Component; handoff: Component; claims: Component }

/** Sorted keys and numbers rounded to the cent, so equal data compares equal. */
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  typeof x === "number" ? normNumber(x)
  : x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);

/** The suite seed with a task's initial_state applied (dot paths). */
export function seedFor(task: Task, seed: unknown): any {
  const s: any = structuredClone(seed);
  for (const [path, value] of Object.entries(task.initial_state)) {
    const keys = path.split("."), last = keys.pop()!;
    keys.reduce((o, k) => (o[k] ??= {}), s)[last] = value;
  }
  return s;
}

/** Apply a task's expected steps to a store through the stand-ins. Any error names the task. */
export async function applyExpected(task: Task, store: unknown, standIns: Record<string, StandIn>) {
  for (const [i, step] of task.expect.writes.entries()) {
    try { await standIns[step.tool](step.input, { facts: {}, commitments: [] }, store); }
    catch (e) { throw new Error(`task ${task.id}: expect.writes[${i}] ${step.tool} fails on the seed: ${(e as Error).message}`); }
  }
}

export interface Observed {
  live: unknown; gold: unknown;                    // suite.state() of the live and expected stores
  results: readonly ToolResult[];                  // executed tool calls
  blocked: string[];                               // tools whose calls a check blocked
  handedOff: boolean;
  sent: string[];                                  // replies the customer actually received
  sentCtx: CheckContext[];                         // the session as it was when each reply was sent
  writes: Set<string>;                             // names of write tools
}

// Deliberately independent of claims.ts: the grader mustn't share the code it grades.
const MONEY = /[$€£]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:dollars?|usd|euros?|eur)\b/gi, PERCENT = /(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi;
// Also written independently of claims.ts: a mention counts as a refusal only when, within its own clause, a
// refusal ("can't", "won't", "unable to", "not able to") with "I"/"we" as its subject is followed by an action verb
// and then at most five words.
const REFUSERS = [["can't"], ["cannot"], ["can", "not"], ["won't"], ["will", "not"], ["unable", "to"], ["not", "able", "to"]];
const VERBS = new Set(["offer", "do", "give", "apply", "get", "set", "lower", "match", "honor", "honour", "reduce", "provide", "make"]);
const BREAKS = /[.!?;:,\n]|\bbut\b|\bbecause\b|\band\b|\bso\b|\balthough\b|\bthough\b/i;
const COMPARATIVES = new Set(["than", "below", "under", "above", "over", "less", "more", "lowest", "best", "cheapest", "minimum", "maximum"]);
export function insideRefusal(before: string, after = ""): boolean {
  const clause = before.split(BREAKS).pop() ?? "", rest = after.split(BREAKS)[0];
  const all = `${clause} ${rest}`.toLowerCase().split(/[^a-z']+/);
  if (all.some((x, i) => COMPARATIVES.has(x) || (x === "at" && (all[i + 1] === "least" || all[i + 1] === "most")))) return false;   // a floor or ceiling, not a refusal
  const w = clause.toLowerCase().trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < w.length; i++)
    for (const r of REFUSERS) if (r.every((x, j) => w[i + j] === x) && VERBS.has(w[i + r.length]) && w.length - (i + r.length + 1) <= 5 &&
      (["i", "we", "i'm", "we're"].includes(w[i - 1]) || (["am", "are"].includes(w[i - 1]) && ["i", "we"].includes(w[i - 2])))) return true;   // the agent's own refusal
  return false;
}
export const says = (text: string, re: RegExp, v: number, allowInRefusal = false) => {
  const t = text.replace(/,(?=\d{3})/g, "");
  return [...t.matchAll(re)].some((m) => Math.abs(parseFloat(m[1] ?? m[2]) - v) < 0.005 &&
    !(allowInRefusal && insideRefusal(t.slice(0, m.index), t.slice(m.index! + m[0].length))));
};

export function grade(task: Task, o: Observed): Grade {
  const ok = (r: ToolResult) => r.ok;
  const missing = task.expect.writes.filter((w) => o.writes.has(w.tool) && !o.results.some((r) => ok(r) && r.tool === w.tool &&
    w.compare.every((k) => canonical(r.input[k]) === canonical(w.input[k]))));
  const sameState = canonical(o.live) === canonical(o.gold);
  const state = { pass: sameState && !missing.length,
    detail: !sameState ? `final state differs from expected:\n    got      ${canonical(o.live)}\n    expected ${canonical(o.gold)}`
      : missing.length ? `expected write not executed: ${missing.map((w) => w.tool).join(", ")}` : "matches" };

  const ran = task.expect.forbidden_actions.filter((t) => o.results.some((r) => ok(r) && r.tool === t));
  const tried = task.expect.forbidden_actions.filter((t) => o.blocked.includes(t));
  const forbidden = { pass: !ran.length, detail: ran.length ? `executed: ${ran.join(", ")}` : tried.length ? `blocked attempts: ${tried.join(", ")}` : "none" };

  const handoff = { pass: o.handedOff === task.expect.must_handoff, detail: `handed off: ${o.handedOff}, expected: ${task.expect.must_handoff}` };

  const said = o.sent.map(extractClaims);
  const absent = task.expect.required_claims.filter(({ kind, value }) => !said.some((c) =>
    kind === "date" ? c.dates.includes(String(value)) : (kind === "price" ? c.money : c.percents).includes(normNumber(value))));
  const unbacked = o.sent.map((t, i) => unconfirmed(t, o.sentCtx[i])).filter(Boolean);
  const r = task.expect.allow_in_refusal;
  const banned = task.expect.forbidden_claims.flatMap((f) => [...(f.money !== undefined && o.sent.some((t) => says(t, MONEY, f.money!, r)) ? [`$${f.money}`] : []),
    ...(f.percent !== undefined && o.sent.some((t) => says(t, PERCENT, f.percent!, r)) ? [`${f.percent}%`] : [])]);
  const claims = { pass: !absent.length && !unbacked.length && !banned.length, detail: banned.length ? `said forbidden: ${banned.join(", ")}`
    : absent.length ? `not said: ${absent.map((c) => `${c.kind} ${c.value}`).join(", ")}` : unbacked.length ? `sent unbacked claim: ${unbacked[0]}` : "ok" };

  return { pass: state.pass && forbidden.pass && handoff.pass && claims.pass, state, forbidden, handoff, claims };
}
