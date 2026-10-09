import { beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, allow, approve, check, createSession, forget, memoryStore, read, StaleSession, withStore, write, z, type Session, type SessionStore } from "../src/index.js";
import { postgres } from "../src/stores/postgres.js";
import { scripted, type Step } from "./fake-model.js";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });

const plan = read({ name: "get_plan", description: "Plan.", input: z.object({}), run: () => ({ plan: "Basic", monthlyPrice: 9 }) });
const refund = write({ name: "refund_order", description: "Refund.", input: z.object({ orderId: z.string() }), confirm: false, run: ({ orderId }) => ({ orderId, refunded: true }) });
const askFirst = check("ask_first", (e) => (e.kind === "action" && e.tool.name === "refund_order" ? approve("Refunds are reviewed.") : allow()));
const agentWith = (steps: Step[]) =>
  new Agent({ model: scripted(steps), instructions: "You help.", tools: [plan, refund], checks: [askFirst], builtins: { verified_first: false }, trace: false });

/** The locking rule every store must follow, run against any implementation. */
function storeContract(name: string, make: () => SessionStore) {
  describe(`${name}: the SessionStore contract`, () => {
    it("saves a new session only with expectedRev undefined, and loads a copy", async () => {
      const store = make(), s = createSession({ facts: { accountId: "acc_1" } });
      await store.save(s);
      await expect(store.save(s)).rejects.toThrow(StaleSession);                       // already exists
      const loaded = await store.load(s.id);
      expect(loaded).toEqual(s);
      expect(loaded).not.toBe(s);
      expect(await store.load("s_nobody")).toBeUndefined();
    });
    it("updates only against the rev it loaded", async () => {
      const store = make(), s = createSession();
      await store.save(s);
      await store.save({ ...s, rev: 1 }, 0);
      await expect(store.save({ ...s, rev: 1 }, 0)).rejects.toThrow(`session "${s.id}" changed since rev 0; load it again`);
      await expect(store.save({ ...s, rev: 2 }, 5)).rejects.toThrow(StaleSession);
      await expect(store.save({ ...s, rev: 2 }, undefined)).rejects.toThrow(`session "${s.id}" already exists`);
      expect((await store.load(s.id) as Session).rev).toBe(1);
    });
    it("a tombstone replaces the session and outranks every later save", async () => {
      const store = make(), s = createSession();
      await store.save(s);
      await store.save(forget(s), 0);
      expect(await store.load(s.id)).toEqual({ v: 1, id: s.id, forgotten: true });
      await expect(store.save({ ...s, rev: 1 }, 0)).rejects.toThrow(StaleSession);   // the app's stale copy can't resurrect it
    });
  });
}

storeContract("memoryStore", memoryStore);

/** A fake Postgres: a Map behind the exact SQL the adapter sends, so the contract runs against the real statements. */
function fakePostgres() {
  const sessions = new Map<string, { rev: number; status: string; session: any }>(), traces: any[] = [], sql: { text: string; params?: unknown[] }[] = [];
  const query = async (text: string, params: unknown[] = []) => {
    sql.push({ text, params });
    const [id, rev, status, session, expected] = params as [string, number, string, string, number];
    if (text.startsWith('SELECT session FROM "tla_sessions"')) { const r = sessions.get(id); return { rows: r ? [{ session: structuredClone(r.session) }] : [] }; }
    if (text.startsWith('INSERT INTO "tla_sessions"')) { if (sessions.has(id)) return { rows: [], rowCount: 0 }; sessions.set(id, { rev, status, session: JSON.parse(session) }); return { rows: [], rowCount: 1 }; }
    if (text.startsWith('UPDATE "tla_sessions"')) { const r = sessions.get(id); if (!r || r.rev !== expected) return { rows: [], rowCount: 0 }; sessions.set(id, { rev, status, session: JSON.parse(session) }); return { rows: [], rowCount: 1 }; }
    if (text.startsWith('INSERT INTO "tla_traces"')) { traces.push({ session_id: params[0], turn: params[1], type: params[2], line: JSON.parse(params[3] as string) }); return { rows: [], rowCount: 1 }; }
    if (text.startsWith('DELETE FROM "tla_traces"')) { const n = traces.length; traces.splice(0, n, ...traces.filter((t) => t.session_id !== id)); return { rows: [], rowCount: n - traces.length }; }
    throw new Error(`fake postgres: unexpected SQL ${text}`);
  };
  return { query, sessions, traces, sql };
}

storeContract("postgres (fake query)", () => postgres({ query: fakePostgres().query }).store);

describe("postgres adapter", () => {
  it("sends parameterised statements with quoted identifiers, and stores jsonb as JSON text", async () => {
    const db = fakePostgres(), { store } = postgres({ query: db.query, sessions: "app.convos" });
    await expect(store.load("s_1").catch((e) => e.message)).resolves.toMatch(/unexpected SQL SELECT session FROM "app"\."convos"/);
    const s = createSession();
    const plain = postgres({ query: db.query }).store;
    await plain.save(s);
    expect(db.sql.at(-1)).toEqual({ text: 'INSERT INTO "tla_sessions" (id, rev, status, session) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', params: [s.id, 0, "open", JSON.stringify(s)] });
    await plain.save({ ...s, rev: 1, status: "handed_off" }, 0);
    expect(db.sql.at(-1)!.text).toBe('UPDATE "tla_sessions" SET rev = $2, status = $3, session = $4, updated_at = now() WHERE id = $1 AND rev = $5');
    expect(db.sql.at(-1)!.params!.slice(1, 3)).toEqual([1, "handed_off"]);
    await plain.save(forget(s), 1);
    expect(db.sessions.get(s.id)).toMatchObject({ rev: -1, status: "forgotten" });
  });
  it("refuses a table name that isn't a plain identifier", () => {
    for (const bad of ['x"; DROP TABLE y; --', "a b", "1abc", "a.b.c", ""]) expect(() => postgres({ query: fakePostgres().query, sessions: bad })).toThrow(/isn't a plain table name/);
    expect(() => postgres({ query: fakePostgres().query, traces: "audit.lines" })).not.toThrow();
  });
  it("the trace sink inserts one row per line and deletes a session's rows on forget", async () => {
    const db = fakePostgres(), { trace } = postgres({ query: db.query });
    trace.write({ type: "turn", sessionId: "s_1", turn: 1, reply: "hi" });
    trace.write({ type: "turn", sessionId: "s_2", turn: 1, reply: "yo" });
    await new Promise((r) => setTimeout(r));
    expect(db.traces.map((t) => [t.session_id, t.turn, t.type, t.line.reply])).toEqual([["s_1", 1, "turn", "hi"], ["s_2", 1, "turn", "yo"]]);
    trace.forget!("s_1");
    await new Promise((r) => setTimeout(r));
    expect(db.traces.map((t) => t.session_id)).toEqual(["s_2"]);
  });
  it("a failing trace write is reported, never thrown", async () => {
    const onError = vi.fn();
    const { trace } = postgres({ query: async () => { throw new Error("connection lost"); }, onError });
    expect(() => trace.write({ type: "turn", sessionId: "s_1", turn: 1 })).not.toThrow();
    await new Promise((r) => setTimeout(r));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "connection lost" }));
    const { trace: noisy } = postgres({ query: async () => { throw new Error("connection lost"); } });
    noisy.write({ type: "turn", sessionId: "s_1", turn: 1 });
    await new Promise((r) => setTimeout(r));
    expect(console.warn).toHaveBeenCalledWith("⚠️  postgres trace: connection lost");
  });
  it("ships the schema for both tables, with the configured names", () => {
    const { schema } = postgres({ query: fakePostgres().query, sessions: "convos", traces: "audit.lines" });
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS "convos" (id text PRIMARY KEY, rev integer NOT NULL, status text NOT NULL, session jsonb NOT NULL');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS "audit"."lines" (id bigserial PRIMARY KEY, session_id text NOT NULL, turn integer, type text NOT NULL, line jsonb NOT NULL');
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS "audit_lines_session" ON "audit"."lines" (session_id)');
  });
  it("passes mask through to the agent", () => {
    expect(postgres({ query: fakePostgres().query }).trace.mask).toBeUndefined();
    expect(postgres({ query: fakePostgres().query, mask: false }).trace.mask).toBe(false);
  });
});

describe("withStore: the agent's verbs by session id", () => {
  it("respond(null) creates and saves; respond(id) loads, acts and saves against the loaded rev", async () => {
    const store = memoryStore(), bound = withStore(agentWith([{ call: "get_plan" }, "You're on Basic at $9/month.", "Still Basic."]), store);
    const t1 = await bound.respond(null, "What plan am I on?");
    expect(t1.reply).toBe("You're on Basic at $9/month.");
    expect((await store.load(t1.session.id) as Session).rev).toBe(1);
    const t2 = await bound.respond(t1.session.id, "Sure?");
    expect([t2.reply, (await store.load(t1.session.id) as Session).rev, t2.session.messages.length]).toEqual(["Still Basic.", 2, 4]);
  });
  it("two turns on one session at once: the second save is refused, nothing is lost", async () => {
    const store = memoryStore(), bound = withStore(agentWith(["Hello.", "First.", "Second."]), store);
    const { session } = await bound.respond(null, "hi");
    const [a, b] = await Promise.allSettled([bound.respond(session.id, "one"), bound.respond(session.id, "two")]);
    expect([a.status, b.status]).toEqual(["fulfilled", "rejected"]);
    expect((b as PromiseRejectedResult).reason).toBeInstanceOf(StaleSession);
    expect((await store.load(session.id) as Session).messages.at(-2)!.text).toBe("one");
  });
  it("approve, decline and review work by id; forget stores the tombstone and ends the session", async () => {
    const store = memoryStore(), forgetTrace = vi.fn();
    const agent = new Agent({ model: scripted(["Shall I refund order 7?", { call: "refund_order", input: { orderId: "7" } }, "Requested.", "Done: refunded."]),
      instructions: "You help.", tools: [plan, refund], checks: [askFirst], builtins: { verified_first: false }, trace: { write() {}, forget: forgetTrace } });
    const bound = withStore(agent, store);
    const { session } = await bound.respond(null, "refund order 7");
    const t2 = await bound.respond(session.id, "yes");
    expect(t2.approvals?.[0]).toMatchObject({ id: "p_1", status: "pending" });
    const { session: after } = await bound.approve(session.id, "p_1");
    expect([after.approvals[0].status, (await store.load(session.id) as Session).rev]).toEqual(["approved", 3]);
    expect((await bound.review(session.id, "Your refund has been processed.")).result).toEqual({ allow: true });
    expect((await bound.review(null, "Your refund has been processed.")).result).toHaveProperty("block");
    await expect(bound.decline(session.id, "p_1")).rejects.toThrow('no pending approval "p_1"');
    const t = await bound.forget(session.id);
    expect(t).toEqual({ v: 1, id: session.id, forgotten: true });
    expect(forgetTrace).toHaveBeenCalledWith(session.id);
    expect(await store.load(session.id)).toEqual(t);
    await expect(bound.respond(session.id, "hello?")).rejects.toThrow(`no session "${session.id}" (forgotten)`);
    await expect(bound.respond("s_nobody", "hello?")).rejects.toThrow('no session "s_nobody"');
  });
  it("runs the same flow over the postgres adapter", async () => {
    const db = fakePostgres(), { store, trace } = postgres({ query: db.query });
    const bound = withStore(new Agent({ model: scripted(["Hello.", "Again."]), instructions: "You help.", tools: [plan], trace, builtins: { verified_first: false } }), store);
    const { session } = await bound.respond(null, "hi");
    await bound.respond(session.id, "hi again");
    await new Promise((r) => setTimeout(r));
    expect(db.sessions.get(session.id)).toMatchObject({ rev: 2, status: "open" });
    expect(db.traces.filter((t) => t.session_id === session.id).map((t) => t.type)).toEqual(["turn", "turn"]);
    await bound.forget(session.id);
    await new Promise((r) => setTimeout(r));
    expect([db.sessions.get(session.id)!.status, db.traces.length]).toEqual(["forgotten", 0]);
  });
});
