import { contextFrom, type CheckContext, type ToolInfo } from "../src/checks.js";
import { createSession, type Commitment, type Json, type Message, type Session, type ToolResult } from "../src/session.js";

export const tools: ToolInfo[] = [
  { name: "verify_customer", kind: "read", beforeVerification: true, verifies: true },
  { name: "get_account", kind: "read" },
  { name: "quote_plan_change", kind: "read" },
  { name: "change_plan", kind: "write", confirm: { commitment: "quote", by: "quoteId" } },
  { name: "open_case", kind: "write", confirm: false },
];

let n = 0;
export const ok = (tool: string, output: Json, turn = 1): ToolResult => ({ id: `c_${++n}`, tool, turn, ok: true, input: {}, output });
export const failed = (tool: string, code = "billing_unavailable", turn = 1): ToolResult =>
  ({ id: `c_${++n}`, tool, turn, ok: false, input: {}, error: { code, message: "failed" } });

/** Build a check context from a compact conversation: ["c: hi", "a: hello", ...]. */
export function ctx(opts: {
  say?: string[]; results?: ToolResult[]; commitments?: Commitment[]; facts?: Record<string, Json>;
  operatorText?: string[]; failures?: number; tools?: ToolInfo[]; now?: Date;
} = {}): CheckContext {
  let turn = 0;
  const messages: Message[] = (opts.say ?? []).map((line) => {
    const role = line.startsWith("c:") ? "user" : "agent";
    if (role === "user") turn++;
    return { role, text: line.slice(2).trim(), turn };
  });
  const session: Session = { ...createSession({ facts: opts.facts ?? { verified: true } }), messages,
    results: opts.results ?? [], commitments: opts.commitments ?? [], failures: opts.failures ?? 0 };
  return contextFrom(session, opts.tools ?? tools, opts.operatorText ?? [], opts.now ?? new Date("2026-10-03T12:00:00Z"));
}

export const quote = (over: Partial<Commitment> = {}): Commitment => ({
  type: "quote", id: "q_1", by: "quote_plan_change", values: { monthlyPrice: 29, proratedCharge: 4.12 },
  turn: 1, shownTurn: 1, status: "open", expiresAt: "2026-10-04T00:00:00Z", ...over,
});
