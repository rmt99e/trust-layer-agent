import type { Agent, Reply } from "./agent.js";
import type { ForgottenSession, Session } from "./session.js";

/**
 * Where sessions live. The library never stores anything itself; a store gives the app's storage two verbs.
 * save(session, expectedRev) MUST refuse (throw StaleSession) when the stored rev isn't expectedRev, or when
 * expectedRev is undefined and a row already exists: that is the optimistic lock `rev` was made for.
 * A forgotten session is saved as its tombstone; load() returns it so the app can tell "forgotten" from "unknown".
 */
export interface SessionStore {
  load(id: string): Promise<Session | ForgottenSession | undefined>;
  save(session: Session | ForgottenSession, expectedRev?: number): Promise<void>;
}

export class StaleSession extends Error {
  constructor(public id: string, public expectedRev: number | undefined) {
    super(expectedRev === undefined ? `session "${id}" already exists` : `session "${id}" changed since rev ${expectedRev}; load it again`);
    this.name = "StaleSession";
  }
}

const revOf = (s: Session | ForgottenSession) => ("forgotten" in s ? -1 : s.rev);   // a tombstone outranks every rev

/** The reference store: a Map. Same locking rule as any other store; for tests, examples and single-process apps. */
export function memoryStore(): SessionStore & { rows: Map<string, Session | ForgottenSession> } {
  const rows = new Map<string, Session | ForgottenSession>();
  return {
    rows,
    async load(id) { const s = rows.get(id); return s && structuredClone(s); },
    async save(s, expectedRev) {
      const was = rows.get(s.id);
      if (expectedRev === undefined ? was !== undefined : !was || revOf(was) !== expectedRev) throw new StaleSession(s.id, expectedRev);
      rows.set(s.id, structuredClone(s));
    },
  };
}

/** An agent over a store: the same verbs by session id. Each call loads, acts, then saves against the rev it loaded. */
export function withStore(agent: Agent, store: SessionStore) {
  const get = async (id: string) => {
    const s = await store.load(id);
    if (!s || "forgotten" in s) throw new Error(`no session "${id}"${s ? " (forgotten)" : ""}`);
    return s;
  };
  const put = async <T extends { session: Session }>(r: T, was?: number) => { await store.save(r.session, was); return r; };
  return {
    async respond(id: string | null, message: string): Promise<Reply> {
      const s = id ? await get(id) : null;
      return put(await agent.respond(s, message), s?.rev);
    },
    async approve(id: string, approvalId: string) { const s = await get(id); return put(await agent.approve(s, approvalId), s.rev); },
    async decline(id: string, approvalId: string, reason?: string) { const s = await get(id); return put(await agent.decline(s, approvalId, reason), s.rev); },
    async review(id: string | null, draft: string) { return agent.review(id ? await get(id) : null, draft); },
    /** Deletes the trace (through the agent's sink) and stores the tombstone in the session's place. */
    async forget(id: string): Promise<ForgottenSession> { const s = await get(id), t = agent.forget(s); await store.save(t, s.rev); return t; },
  };
}
