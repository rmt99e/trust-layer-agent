import { randomUUID } from "node:crypto";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Commitment {
  type: string;
  id: string;
  by: string;                 // tool that created it
  values: Record<string, Json>;
  turn: number;
  shownTurn?: number;
  acceptedTurn?: number;
  status: "open" | "accepted" | "used" | "expired";
  expiresAt?: string;
}

export interface ToolResult {
  id: string;
  tool: string;
  turn: number;
  ok: boolean;
  input: Record<string, Json>;
  output?: Json;              // visible fields only
  error?: { code: string; message: string };
  outcome?: "done" | "pending" | "unknown";   // writes; a failed call without one is a known failure
  outcomeError?: string;                      // the tool's outcome() threw; the outcome is treated as unknown
}

export interface Message { role: "user" | "agent"; text: string; turn: number }

/** An action a check parked for a person to decide. Either decision ends in a ToolResult (`result`). */
export interface Approval {
  id: string;                 // "p_<n>"
  tool: string;
  input: Record<string, Json>;
  turn: number;
  reason: string;             // what the check said
  by: string;                 // the check that asked
  status: "pending" | "approved" | "declined";
  result?: string;            // the ToolResult id once decided
}

export interface Session {
  v: 2;
  id: string;
  rev: number;
  status: "open" | "handed_off" | "closed";
  facts: Record<string, Json>;
  commitments: Commitment[];
  results: ToolResult[];
  messages: Message[];
  approvals: Approval[];
  failures: number;
}

export interface ForgottenSession { v: 2; id: string; forgotten: true }

/** Start a session. Facts passed here come from app code (e.g. a logged-in user) and are trusted. */
export function createSession(opts: { facts?: Record<string, Json> } = {}): Session {
  const id = "s_" + randomUUID().replace(/-/g, "").slice(0, 12);
  return { v: 2, id, rev: 0, status: "open", facts: { ...opts.facts }, commitments: [], results: [], messages: [], approvals: [], failures: 0 };
}

/** The v0.1 session: the user was the "customer" and there were no approvals. loadSession() upgrades it. */
export type SessionV1 = Omit<Session, "v" | "messages" | "approvals"> & { v: 1; messages: { role: "customer" | "agent"; text: string; turn: number }[]; approvals?: Approval[] };

/** A copy of a stored session, upgraded to v2 (idempotent). Every agent method loads a given session this way. */
export function loadSession(session: Session | SessionV1): Session {
  const s = structuredClone(session);
  return { ...s, v: 2, approvals: s.approvals ?? [], messages: s.messages.map((m) => (m.role === "customer" ? { ...m, role: "user" as const } : m) as Message) };
}

/** Drop everything but the id. The app overwrites or deletes its stored copy. */
export function forget(session: Session): ForgottenSession {
  return { v: 2, id: session.id, forgotten: true };
}

/** The current turn: the number of user messages so far. */
export function currentTurn(session: Session): number {
  return session.messages.filter((m) => m.role === "user").length;
}
