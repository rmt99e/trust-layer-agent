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
  ctx: CheckContext;                               // final session context, for re-running claim checks
  writes: Set<string>;                             // names of write tools
}

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
  const unbacked = o.sent.map((t) => unconfirmed(t, o.ctx)).filter(Boolean);
  const claims = { pass: !absent.length && !unbacked.length, detail: absent.length ? `not said: ${absent.map((c) => `${c.kind} ${c.value}`).join(", ")}`
    : unbacked.length ? `sent unbacked claim: ${unbacked[0]}` : "ok" };

  return { pass: state.pass && forbidden.pass && handoff.pass && claims.pass, state, forbidden, handoff, claims };
}
