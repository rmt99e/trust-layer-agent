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
}

export interface Message { role: "customer" | "agent"; text: string; turn: number }

export interface Session {
  v: 1;
  id: string;
  rev: number;
  status: "open" | "handed_off" | "closed";
  facts: Record<string, Json>;
  commitments: Commitment[];
  results: ToolResult[];
  messages: Message[];
  failures: number;
}

export interface ForgottenSession { v: 1; id: string; forgotten: true }

/** Start a session. Facts passed here come from app code (e.g. a logged-in user) and are trusted. */
export function createSession(opts: { facts?: Record<string, Json> } = {}): Session {
  const id = "s_" + randomUUID().replace(/-/g, "").slice(0, 12);
  return { v: 1, id, rev: 0, status: "open", facts: { ...opts.facts }, commitments: [], results: [], messages: [], failures: 0 };
}

/** Drop everything but the id. The app overwrites or deletes its stored copy. */
export function forget(session: Session): ForgottenSession {
  return { v: 1, id: session.id, forgotten: true };
}

/** The current turn: the number of customer messages so far. */
export function currentTurn(session: Session): number {
  return session.messages.filter((m) => m.role === "customer").length;
}
