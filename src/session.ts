import { randomUUID } from "node:crypto";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A stored session id is checked against this on load: ids become trace file names. */
export const SESSION_ID = /^s_[0-9a-f]{12}$/;
export const FACTS_PREFIX = "facts.";
/** A successful write with this name ends the turn as a handoff. It needs no yes: confirm defaults to false. */
export const HANDOFF_TOOL = "handoff_to_person";

export interface Commitment {
  type: string;
  id: string;
  by: string;                 // tool that created it
  values: Record<string, Json>;
  turn: number;
  shownTurn?: number;
  acceptedTurn?: number;
  status: "open" | "accepted" | "used" | "expired";   // only open and used are set today; accepted and expired are reserved
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
  recordsError?: string;                      // the tool's records() threw; nothing was recorded, and a write's outcome is unknown
}

export interface Message { role: "user" | "agent"; text: string; turn: number }

/** An action a check parked for a person to decide. Either decision ends in a ToolResult (`result`). */
export interface Approval {
  id: string;                 // "p_<n>"
  tool: string;
  input: Record<string, Json>;
  secret?: string[];          // the tool's secret fields when parked, so the record can be redacted even if the tool is gone
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
  status: "open" | "handed_off" | "closed";   // closed is reserved; nothing sets it today
  facts: Record<string, Json>;
  commitments: Commitment[];
  results: ToolResult[];
  messages: Message[];
  approvals: Approval[];
  failures: number;
}

/** The v0.1 session: the user was the "customer" and there were no approvals. loadSession() upgrades it. */
export type SessionV1 = Omit<Session, "v" | "messages" | "approvals"> & { v: 1; messages: { role: "customer" | "agent"; text: string; turn: number }[]; approvals?: Approval[] };

export interface ForgottenSession { v: 2; id: string; forgotten: true }

/** Start a session. Facts passed here come from app code (e.g. a logged-in user) and are trusted. */
export function createSession(opts: { facts?: Record<string, Json> } = {}): Session {
  const id = "s_" + randomUUID().replace(/-/g, "").slice(0, 12);
  return { v: 2, id, rev: 0, status: "open", facts: { ...opts.facts }, commitments: [], results: [], messages: [], approvals: [], failures: 0 };
}

/** A copy of a stored session, upgraded to v2 (idempotent). Every agent method loads a given session this way. */
export function loadSession(session: Session | SessionV1): Session {
  if (!SESSION_ID.test(String(session.id))) throw new TypeError(`session id "${session.id}" isn't one this library minted`);
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

/** The id the next ToolResult appended to this session gets. */
export const nextResultId = (session: Session) => "c_" + (session.results.length + 1);

/** Normalize a number token: strip commas and currency, compare to the cent. */
export const normNumber = (s: string | number) => Math.round(parseFloat(String(s).replace(/[^\d.-]/g, "")) * 100) / 100;

const sortKeys = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x);
/** JSON with object keys sorted at every depth, so the same data in any key order compares equal. Numbers are kept exactly. */
export const stableJson = (v: unknown): string => JSON.stringify(v, (_k, x) => sortKeys(x));
/** stableJson with numbers rounded to the cent: the grader's view of equal data. */
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "number" ? normNumber(x) : sortKeys(x)));

/** Every string and number inside a JSON value, in order. */
export const leaves = (v: Json | undefined): (string | number)[] => typeof v === "string" || typeof v === "number" ? [v]
  : Array.isArray(v) ? v.flatMap(leaves) : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [];
