import { TurnFailed, type Agent, type Reply } from "./agent.js";
import { createSession, FACTS_PREFIX, type ForgottenSession, type Json, type Session } from "./session.js";

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
export function memoryStore(): SessionStore {
  const rows = new Map<string, Session | ForgottenSession>();
  return {
    async load(id) { const s = rows.get(id); return s && structuredClone(s); },
    async save(s, expectedRev) {
      const was = rows.get(s.id), stale = expectedRev === undefined ? was !== undefined : expectedRev < 0 || !was || revOf(was) !== expectedRev;
      if (stale) throw new StaleSession(s.id, expectedRev);
      rows.set(s.id, structuredClone(s));
    },
  };
}

/** `owner`: the fact that names whose session it is, e.g. "facts.accountId". Set it and every verb needs `as(owner)` first. */
export interface StoreOptions { owner?: `${typeof FACTS_PREFIX}${string}` }

/**
 * An agent over a store: the same verbs by session id. Each call loads, acts, then saves against the rev it loaded.
 * With `owner` set, `as(owner)` scopes the verbs to one owner: a new session gets the fact, and a session whose fact
 * differs reads as `no session`, the same as one that doesn't exist, so an id from a request can't reach another owner's conversation.
 */
export function withStore(agent: Agent, store: SessionStore, opts: StoreOptions = {}) {
  const key = opts.owner?.slice(FACTS_PREFIX.length);
  const verbs = (owner?: Json) => {
    const scoped = () => { if (key !== undefined && owner === undefined) throw new TypeError(`withStore: sessions are owned by ${opts.owner}; call as(owner) first`); };
    const get = async (id: string) => {
      scoped();
      const s = await store.load(id);
      const mine = s && !("forgotten" in s) && (key === undefined || s.facts[key] === owner);
      if (!mine) throw new Error(`no session "${id}"${s && "forgotten" in s && key === undefined ? " (forgotten)" : ""}`);
      return s;
    };
    const fresh = () => { scoped(); return key === undefined ? null : createSession({ facts: { [key]: owner! } }); };
    const put = async <T extends { session: Session }>(r: T, was?: number) => { await store.save(r.session, was); return r; };
    return {
      /** A turn the model failed is saved too (TurnFailed carries it), so the writes it ran are not lost; the error is rethrown. A save that fails instead throws its own error, with the TurnFailed as `cause` when it has none. */
      async respond(id: string | null, message: string): Promise<Reply> {
        const s = id ? await get(id) : fresh(), was = id ? s!.rev : undefined;
        try { return await put(await agent.respond(s, message), was); }
        catch (e) {
          if (e instanceof TurnFailed) await store.save(e.session, was).catch((err: unknown) => {
            if (err instanceof Error && err.cause === undefined && !Object.isFrozen(err)) err.cause = e;
            throw err;
          });
          throw e;
        }
      },
      async approve(id: string, approvalId: string, o?: { by?: string }) { const s = await get(id); return put(await agent.approve(s, approvalId, o), s.rev); },
      async decline(id: string, approvalId: string, o?: { reason?: string; by?: string }) { const s = await get(id); return put(await agent.decline(s, approvalId, o), s.rev); },
      async resume(id: string, o?: { note?: string; by?: string }): Promise<Session> { const s = await get(id), r = agent.resume(s, o); await store.save(r, s.rev); return r; },
      async review(id: string | null, draft: string) { return agent.review(id ? await get(id) : null, draft); },
      /** Deletes the trace (through the agent's sink) first, then stores the tombstone: a lost race leaves the trace gone and the session live, and a retried forget finishes the job. */
      async forget(id: string): Promise<ForgottenSession> { const s = await get(id), t = agent.forget(s); await store.save(t, s.rev); return t; },
    };
  };
  return { ...verbs(), as(owner: Json) { if (key === undefined) throw new TypeError(`withStore: pass { owner: "facts.<key>" } to use as()`); return verbs(owner); } };
}
