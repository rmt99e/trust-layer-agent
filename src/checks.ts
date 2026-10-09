import { currentTurn, type Approval, type Commitment, type Json, type Message, type Session, type ToolResult } from "./session.js";
import type { Tool } from "./tools.js";

/** What a check may know about a tool: its declaration, never its implementation or schema. */
export interface ToolInfo {
  name: string;
  kind: "read" | "write";
  bind?: Record<string, string>;
  fromUser?: string[];
  confirm?: false | { commitment: string; by: string };
  beforeVerification?: boolean;
  verifies?: boolean;
  reconcileWith?: string;
  repeatable?: boolean;
}
export const toolInfo = ({ name, kind, bind, fromUser, confirm, beforeVerification, verifies, reconcileWith, repeatable }: Tool): ToolInfo =>
  ({ name, kind, bind: bind as Record<string, string> | undefined, fromUser, confirm, beforeVerification, verifies, reconcileWith, repeatable });

export type CheckEvent = { kind: "action"; tool: ToolInfo; input: Record<string, Json> } | { kind: "reply"; text: string };
export type CheckResult = { allow: true } | { block: string } | { rewrite: string } | { handoff: string } | { approve: string };

export interface CheckContext {
  facts: Readonly<Record<string, Json>>;
  commitments: readonly Commitment[];
  results: readonly ToolResult[];
  messages: readonly Message[];        // conversation so far; the last is the user's
  approvals: readonly Approval[];      // actions parked for a person, pending or decided
  failures: number;
  turn: number;
  tools: readonly ToolInfo[];
  operatorText: readonly string[];     // instructions, journeys, knowledge docs
  now: Date;
}
export interface Check { name: string; run(e: CheckEvent, ctx: CheckContext): CheckResult | Promise<CheckResult> }

export const allow = (): CheckResult => ({ allow: true });
export const block = (reason: string): CheckResult => ({ block: reason });
export const rewrite = (text: string): CheckResult => ({ rewrite: text });
export const handoff = (summary: string): CheckResult => ({ handoff: summary });
export const approve = (reason: string): CheckResult => ({ approve: reason });   // actions only: park it for a person
export const check = (name: string, run: Check["run"]): Check => ({ name, run });

export function contextFrom(session: Session, tools: readonly ToolInfo[], operatorText: readonly string[] = [], now = new Date()): CheckContext {
  const { facts, commitments, results, messages, approvals = [], failures } = session;
  return { facts, commitments, results, messages, approvals, failures, turn: currentTurn(session), tools, operatorText, now };
}

export interface Verdict { result: CheckResult; by?: string; text?: string; trail: { check: string; result: CheckResult }[] }

/** Run checks in order. Actions: first non-allow wins. Replies: rewrites chain; block or handoff stops. */
export async function runChecks(event: CheckEvent, ctx: CheckContext, checks: readonly Check[]): Promise<Verdict> {
  const trail: Verdict["trail"] = [];
  let text = event.kind === "reply" ? event.text : undefined, rewrittenBy: string | undefined;
  for (const c of checks) {
    let result: CheckResult;
    try { result = await c.run(event.kind === "reply" ? { kind: "reply", text: text! } : event, ctx); }
    catch (e) { throw new Error(`check "${c.name}" threw: ${(e as Error).message}`, { cause: e }); }
    trail.push({ check: c.name, result });
    if ("allow" in result) continue;
    if ("approve" in result && event.kind === "reply") throw new Error(`check "${c.name}" returned approve for a reply; approve applies to actions only`);
    if ("rewrite" in result) {
      if (event.kind === "action") throw new Error(`check "${c.name}" returned rewrite for an action; rewrite applies to replies only`);
      text = result.rewrite;
      rewrittenBy = c.name;                                         // named in the trace line for the sent reply
      continue;
    }
    return { result, by: c.name, text, trail };
  }
  const rewritten = event.kind === "reply" && text !== event.text;
  return { result: rewritten ? rewrite(text!) : allow(), by: rewritten ? rewrittenBy : undefined, text, trail };
}
