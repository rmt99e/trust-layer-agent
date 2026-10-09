// A turn the model fails: what survives, and what the next turn does with it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allow, approve, check, memoryStore, TurnFailed, withStore, write, z, type Model, type Session } from "../src/index.js";
import { scripted } from "./fake-model.js";
import { agent, lines, session } from "./harness.js";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); lines.length = 0; });

describe("a turn that fails after a tool ran", () => {
  const charge = write({ name: "charge_card", description: "Charge the card.", input: z.object({ amount: z.number() }), confirm: false, run: () => ({ charged: true }) });
  const boom = new Error("provider down");
  /** Calls charge_card, then the provider dies; on a later turn it tries the same charge again, then answers. */
  const flaky = (): Model & { requests: any[] } => {
    const inner = scripted([{ call: "charge_card", input: { amount: 5 } }, { call: "charge_card", input: { amount: 5 } }, "Yes, it went through."]);
    let n = 0;
    return { id: "fake:flaky", requests: inner.requests, generate: (req) => (++n === 2 ? Promise.reject(boom) : inner.generate(req)) };
  };
  it("rejects with TurnFailed carrying the session so far: the user's message, the write that ran, rev bumped; the input session untouched", async () => {
    const s = session(), err = await agent(flaky(), [charge]).respond(s, "charge me 5").catch((e) => e);
    expect(err).toBeInstanceOf(TurnFailed);
    expect([err.cause, err.message]).toEqual([boom, "turn 1 failed: provider down"]);
    expect(err.session.results.map((r: any) => [r.tool, r.ok])).toEqual([["charge_card", true]]);
    expect([err.session.rev, err.session.messages]).toEqual([1, [{ role: "user", text: "charge me 5", turn: 1, at: expect.any(String) }]]);
    expect([s.results, s.messages, s.rev]).toEqual([[], [], 0]);
  });
  it("the next turn replays the failed turn's write to the model, and no_repeated_writes still refuses to run it again", async () => {
    const model = flaky(), a = agent(model, [charge]);
    const err = await a.respond(session(), "charge me 5").catch((e) => e);
    lines.length = 0;
    const r = await a.respond(err.session, "did it go through?");
    expect(JSON.stringify(model.requests[2].messages)).toContain(`{\\"charged\\":true}`);          // the result is in the history the model sees
    expect(lines.find((l) => l.type === "check")).toMatchObject({ event: "action", tool: "charge_card", check: "no_repeated_writes" });
    expect([r.reply, r.session.results.length]).toEqual(["Yes, it went through.", 1]);
  });
  it("withStore saves the failed turn's session before rethrowing, so the next turn builds on it", async () => {
    const store = memoryStore(), bound = withStore(agent(flaky(), [charge]), store);
    const err = await bound.respond(null, "charge me 5").catch((e) => e);
    expect(err).toBeInstanceOf(TurnFailed);
    const saved = (await store.load(err.session.id)) as Session;
    expect([saved.rev, saved.results.length]).toEqual([1, 1]);
    const r = await bound.respond(saved.id, "did it go through?");
    expect([r.session.rev, ((await store.load(saved.id)) as Session).rev]).toEqual([2, 2]);
  });
  it("carries the approvals parked before the failure and the usage so far; a model that throws synchronously is caught too", async () => {
    let n = 0;
    const model: Model = { id: "fake:sync", generate: () => { if (++n === 2) throw new Error("sync"); return Promise.resolve({ text: "", stop: "tool_calls", toolCalls: [{ id: "t1", name: "charge_card", input: { amount: 5 } }], usage: { inputTokens: 7, outputTokens: 3 } }); } };
    const a = agent(model, [charge], { checks: [check("big", (e) => (e.kind === "action" ? approve("over the limit") : allow()))] });
    const err = await a.respond(session(), "charge me 5").catch((e) => e);
    expect(err).toBeInstanceOf(TurnFailed);
    expect([err.approvals.map((p: any) => p.id), err.session.approvals.length, err.usage]).toEqual([["p_1"], 1, { inputTokens: 7, outputTokens: 3, calls: 1 }]);
  });
  it("a result a person decided during a failed turn is still replayed to the model next turn", async () => {
    const model = flaky(), a = agent(model, [charge], { checks: [check("big", (e) => (e.kind === "action" ? approve("over the limit") : allow()))] });
    const err = await a.respond(session(), "charge me 5").catch((e) => e);
    const { session: s } = await a.approve(err.session, "p_1");
    await a.respond(s, "did it go through?").catch((e) => e);
    const replayed = model.requests[2].messages;
    expect(replayed.findIndex((m: any) => m.role === "tool")).toBeGreaterThan(replayed.findIndex((m: any) => m.role === "user"));
    expect(JSON.stringify(replayed)).toContain(`{\\"charged\\":true}`);
  });
  it("withStore: a save that fails after TurnFailed throws the save's error with the TurnFailed as cause", async () => {
    const inner = memoryStore(), store = { load: inner.load, save: async () => { throw new Error("db down"); } };
    const err = await withStore(agent(flaky(), [charge]), store).respond(null, "charge me 5").catch((e) => e);
    expect([err.message, err.cause]).toEqual(["db down", expect.any(TurnFailed)]);
  });
  it("a check that throws fails closed: the turn hands off naming the check, with reason check_error; review() lets it propagate", async () => {
    const flakyCheck = check("flaky", () => { throw new Error("db down"); });
    const a = agent(scripted(["Hello."]), [charge], { checks: [flakyCheck] });
    const r = await a.respond(session(), "hi");
    expect(r.handoff).toEqual({ summary: 'A check failed: check "flaky" threw: db down', reason: "check_error" });
    expect([r.session.status, r.session.rev]).toEqual(["handed_off", 1]);
    await expect(a.review(session(), "hi")).rejects.toThrow('check "flaky" threw: db down');
  });
});

