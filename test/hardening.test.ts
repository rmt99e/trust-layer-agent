// Edge-of-pipeline behaviour: what happens when a tool, the model or the stored data misbehaves.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, allow, approve, block, check, createSession, handoff, jsonl, loadSession, memoryStore, read, teachingView, ToolError, TurnFailed, withStore, write, z,
  type Model, type ModelResponse, type Session } from "../src/index.js";
import { extractClaims, markShown } from "../src/claims.js";
import { main } from "../src/cli.js";
import { runTool } from "../src/tools.js";
import { scripted, type Step } from "./fake-model.js";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
const session = () => createSession({ facts: { verified: true, accountId: "acc_1" } });
/** A model whose steps may also be raw responses, for stop reasons the scripted model can't express. */
const raw = (steps: (Step | Partial<ModelResponse>)[]): Model & { requests: any[] } => {
  const inner = scripted(steps.filter((s) => typeof s === "string" || "call" in s || "calls" in s) as Step[]);
  let i = 0;
  return { id: "fake:raw", requests: inner.requests, async generate(req) {
    const step = steps[i++];
    if (typeof step === "object" && step && !("call" in step) && !("calls" in step)) { inner.requests.push(structuredClone(req)); return { text: "", toolCalls: [], stop: "end", ...step } as ModelResponse; }
    return inner.generate(req);
  } };
};
const lines: any[] = [];
const sink = { write: (l: any) => lines.push(l) };
const agent = (model: Model, tools: any[], extra: Record<string, unknown> = {}) =>
  new Agent({ model, instructions: "You help.", tools, trace: sink, builtins: { verified_first: false }, ...extra });

describe("a tool whose declaration misbehaves", () => {
  it("records() throwing doesn't crash the turn: nothing is recorded, the error is on the result, and a write's outcome is unknown until its read settles it", async () => {
    lines.length = 0;
    const refund = write({ name: "refund_order", description: "Refund.", input: z.object({ orderId: z.string() }), confirm: false, reconcileWith: "get_order",
      records: (o: any) => ({ facts: { last: o.missing.id } }), run: () => ({ refunded: 42 }) });
    const getOrder = read({ name: "get_order", description: "Order.", input: z.object({ orderId: z.string() }), run: () => ({ status: "refunded" }) });
    const r = await agent(scripted([{ call: "refund_order", input: { orderId: "9" } }, "Your refund has been processed."]), [refund, getOrder]).respond(session(), "refund order 9");
    expect(r.session.results[0]).toMatchObject({ ok: true, output: { refunded: 42 }, outcome: "unknown", recordsError: expect.stringContaining("Cannot read properties of undefined") });
    expect(r.session.facts.last).toBeUndefined();
    expect(lines.filter((l) => l.type === "tool").map((l) => [l.tool, l.outcome, l.reconcile ?? false, typeof l.recordsError])).toEqual([["refund_order", "unknown", false, "string"], ["get_order", undefined, true, "undefined"]]);
    expect(r.reply).toBe("Your refund has been processed.");                              // the reconcile read settled it
  });
  it("output is normalized to JSON: a Date becomes a string, the session round-trips, and a value that isn't JSON fails the call", async () => {
    const when = read({ name: "get_when", description: "When.", input: z.object({}), visible: ["at", "n"], run: () => ({ at: new Date("2026-10-03T12:00:00Z"), n: undefined }) });
    const r = await agent(scripted([{ call: "get_when" }, "Noted."]), [when]).respond(session(), "go");
    expect(r.session.results[0].output).toEqual({ at: "2026-10-03T12:00:00.000Z" });
    expect(JSON.parse(JSON.stringify(r.session))).toEqual(r.session);
    const big = write({ name: "set_big", description: "Big.", input: z.object({}), confirm: false, run: () => ({ n: 10n }) });
    const { result } = await runTool(big, {}, session());
    expect(result).toMatchObject({ ok: false, error: { code: "not_json", message: "The tool returned a value that isn't JSON." }, outcome: "unknown" });
    const bigRead = read({ name: "get_big", description: "Big.", input: z.object({}), run: () => ({ n: 10n }) });
    expect((await runTool(bigRead, {}, session())).result).toMatchObject({ ok: false, error: { code: "not_json" } });
    expect((await runTool(bigRead, {}, session())).result.outcome).toBeUndefined();
  });
  it("handoff_to_person needs no confirm: false and ends the turn without a yes", async () => {
    const handoffTool = write({ name: "handoff_to_person", description: "Hand off.", input: z.object({ summary: z.string() }), run: ({ summary }) => ({ handedOff: true, summary }) });
    expect(handoffTool.confirm).toBe(false);
    const r = await agent(scripted([{ call: "handoff_to_person", input: { summary: "Wants a person." } }]), [handoffTool]).respond(session(), "get me a human");
    expect(r.handoff).toEqual({ summary: "Wants a person.", reason: "handoff_to_person" });
  });
});

describe("a model whose reply is incomplete", () => {
  const order = read({ name: "get_order", description: "Order.", input: z.object({}), run: () => ({ status: "shipped" }) });
  it.each([
    ["cut off by the output limit", { text: "Your order has", stop: "max_tokens" as const }, "The draft was cut off by the model's output limit. Write a shorter reply."],
    ["empty", { text: "  \n", stop: "end" as const }, "The draft was empty. Write a reply."],
  ])("a draft %s is refused and the model writes again, without the bad draft being replayed", async (_n, step, reason) => {
    lines.length = 0;
    const model = raw([step, "Your order has shipped."]);
    const r = await agent(model, [order]).respond(session(), "where is it?");
    expect(r.reply).toBe("Your order has shipped.");
    expect(lines.find((l) => l.type === "check" && l.event === "reply")).toMatchObject({ check: "complete_reply", result: { block: reason } });
    const msgs = model.requests[1].messages;
    expect(msgs.at(-1)!.content).toContain(`That draft was not sent. ${reason}`);
    expect(msgs.at(-2)!.role).toBe("user");                                                 // the cut-off text itself is not sent back as an assistant turn
  });
  it("a refusal hands off, and so does exceeding maxToolCalls", async () => {
    const r = await agent(raw([{ text: "", stop: "refusal" }]), [order]).respond(session(), "hi");
    expect(r.handoff).toEqual({ summary: "The model declined to respond.", reason: "refusal" });
    const many = await agent(scripted([{ calls: [{ call: "get_order" }, { call: "get_order" }] }]), [order], { maxToolCalls: 1 }).respond(session(), "hi");
    expect(many.handoff).toEqual({ summary: "More than 1 tool calls in one turn.", reason: "max_tool_calls" });
  });
  it("a custom check's handoff on an action ends the turn before the tool runs", async () => {
    const run = vi.fn(() => ({ status: "shipped" }));
    const o = read({ name: "get_order", description: "Order.", input: z.object({}), run });
    const stop = check("vip_desk", (e) => (e.kind === "action" && e.tool.name === "get_order" ? handoff("VIP account.") : allow()));
    const r = await agent(scripted([{ call: "get_order" }]), [o], { checks: [stop] }).respond(session(), "hi");
    expect(r.handoff).toEqual({ summary: "VIP account.", reason: "vip_desk" });
    expect(run).not.toHaveBeenCalled();
  });
  it("a reconcile read that fails leaves the outcome unknown and every draft blocked", async () => {
    const change = write({ name: "change_plan", description: "Change.", input: z.object({}), confirm: false, reconcileWith: "get_plan",
      run: () => { throw new ToolError("timeout", "Timed out.", { outcome: "unknown" }); } });
    const plan = read({ name: "get_plan", description: "Plan.", input: z.object({}), run: () => { throw new ToolError("down", "Down."); } });
    const r = await agent(scripted([{ call: "change_plan" }, "It's done.", "Still checking.", "One moment."]), [change, plan]).respond(session(), "switch me");
    expect(r.session.results.map((x) => [x.tool, x.ok, x.outcome])).toEqual([["change_plan", false, "unknown"], ["get_plan", false, undefined]]);
    expect(r.handoff).toMatchObject({ reason: "no_unconfirmed_claims", summary: expect.stringContaining("the outcome of change_plan is unknown") });
    expect(r.session.failures).toBe(3);                                                   // the write, the reconcile read, and the blocked-past-retries handoff
  });
});

describe("stored data the library didn't write", () => {
  it("a session id that isn't the library's shape is refused, and the jsonl sink never leaves its directory", () => {
    const bad = { ...createSession(), id: "../escaped" } as Session;
    expect(() => loadSession(bad)).toThrow('session id "../escaped" isn\'t one this library minted');
    const dir = mkdtempSync(join(tmpdir(), "tla-sink-")), s = jsonl({ dir });
    s.write({ type: "turn", sessionId: "../escaped", turn: 1 });
    expect(existsSync(join(dir, "escaped.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "..", "escaped.jsonl"))).toBe(false);
    s.forget!("../escaped");
    expect(existsSync(join(dir, "escaped.jsonl"))).toBe(false);
    expect(() => agent(scripted([]), []).forget(bad)).toThrow('session id "../escaped" isn\'t one this library minted');
  });
  it("the model can't smuggle a bound field: it never reaches the checks or an approval record", async () => {
    const account = read({ name: "get_account", description: "Account.", input: z.object({ accountId: z.string() }), bind: { accountId: "facts.accountId" }, run: ({ accountId }) => ({ accountId }) });
    const seen: unknown[] = [];
    const park = check("park", (e) => { if (e.kind === "action") { seen.push(e.input); return approve("Look first."); } return allow(); });
    const r = await agent(scripted([{ call: "get_account", input: { accountId: "acc_EVIL" } }, "Requested."]), [account], { checks: [park] })
      .respond(createSession({ facts: { verified: true } }), "show my account");
    expect(seen).toEqual([{}]);
    expect(r.session.approvals[0].input).toEqual({});
    const lines2 = lines.filter((l) => l.type === "check" && l.event === "action");
    expect(JSON.stringify(lines2.at(-1))).not.toContain("acc_EVIL");
  });
});

describe("approvals meet commitments and history", () => {
  const quote = read({ name: "quote_plan_change", description: "Quote.", input: z.object({ planId: z.string() }), visible: ["quoteId", "monthlyPrice"],
    records: (q: { quoteId: string; monthlyPrice: number; expiresAt: string }) => ({ commitments: [{ type: "quote", id: q.quoteId, values: { monthlyPrice: q.monthlyPrice }, expiresAt: q.expiresAt }] }),
    run: () => ({ quoteId: "q_1", monthlyPrice: 29, expiresAt: "2026-10-03T13:00:00Z" }) });
  const change = write({ name: "change_plan", description: "Apply.", input: z.object({ quoteId: z.string() }), confirm: { commitment: "quote", by: "quoteId" }, run: () => ({ status: "active" }) });
  const askFirst = check("ask_first", (e) => (e.kind === "action" && e.tool.name === "change_plan" ? approve("Plan changes need a look.") : allow()));
  const parkIt = async (now: () => Date) => {
    const a = agent(scripted([{ call: "quote_plan_change", input: { planId: "plus" } }, "Plus is $29/month. Shall I?", { call: "change_plan", input: { quoteId: "q_1" } }, "Requested.", "Done, you're on Plus."]), [quote, change], { checks: [askFirst], now });
    const t2 = await a.respond((await a.respond(session(), "switch me")).session, "yes");
    return { a, t2 };
  };
  it("approve() refuses a quote that expired while parked, as a commitment_unusable failure that isn't a tool failure", async () => {
    let clock = new Date("2026-10-03T12:00:00Z");
    const { a, t2 } = await parkIt(() => clock);
    clock = new Date("2026-10-03T14:00:00Z");
    const { result, session: after } = await a.approve(t2.session, "p_1");
    expect(result).toMatchObject({ ok: false, error: { code: "commitment_unusable", message: 'quote "q_1" expired before it was approved.' } });
    expect([after.commitments[0].status, after.failures]).toEqual(["open", 0]);
  });
  it("the same call in a different key order is parked once; a different amount is parked again", async () => {
    const pay = write({ name: "pay", description: "Pay.", input: z.object({ to: z.object({ id: z.string(), bank: z.string() }), amount: z.number() }), confirm: false, run: () => ({ ok: true }) });
    const park = check("park", (e) => (e.kind === "action" ? approve("All payments.") : allow()));
    const a = agent(scripted(["Shall I?", { calls: [
      { call: "pay", input: { to: { id: "x", bank: "b" }, amount: 10.001 } }, { call: "pay", input: { amount: 10.001, to: { bank: "b", id: "x" } } }, { call: "pay", input: { to: { id: "x", bank: "b" }, amount: 10.004 } }] }, "Requested."]), [pay], { checks: [park] });
    const t = await a.respond((await a.respond(session(), "pay x")).session, "yes");
    expect(t.session.approvals.map((p) => p.input.amount)).toEqual([10.001, 10.004]);
  });
  it("after approve(), the model sees the result after the reply that said 'requested', not before it", async () => {
    const { a, t2 } = await parkIt(() => new Date("2026-10-03T12:00:00Z"));
    const { session: after, result } = await a.approve(t2.session, "p_1");
    expect(result.ok).toBe(true);
    const t3 = await a.respond(after, "all good?");
    const msgs = (a.model as any).requests.at(-1).messages as { role: string; content: string; toolCalls?: { name: string }[] }[];
    const replyAt = msgs.findIndex((m) => m.role === "assistant" && m.content === "Requested.");
    const callAt = msgs.findIndex((m) => m.toolCalls?.[0]?.name === "change_plan");
    expect(replyAt).toBeGreaterThan(-1);
    expect(callAt).toBe(replyAt + 1);
    expect(t3.reply).toBe("Done, you're on Plus.");
  });
});

describe("claims: ids and worded prices", () => {
  it("markShown matches a commitment id as a whole token", () => {
    const k = (id: string) => ({ type: "quote", id, by: "q", values: { monthlyPrice: 99 }, turn: 1, status: "open" as const });
    expect(markShown([k("q_1"), k("q_10")], "Your quote is q_10.", 1).map((x) => x.shownTurn)).toEqual([undefined, 1]);
  });
  it('"29 a month" is a price claim; so, as an accepted false positive, is "2 per day"', () => {
    expect(extractClaims("Plus is 29 a month, or 290 per year.").money).toEqual([29, 290]);
    expect(extractClaims("You can change plans 2 per day.").money).toEqual([2]);          // tabled: a rate, not a price, but blocked unless a tool returned 2
  });
  it("first-person done wording never included 'completed', and still doesn't", () => {
    expect(extractClaims("I've completed my review of your account.").done).toEqual([]);
    expect(extractClaims("Your request has been completed.").done).toEqual(["has been completed"]);
  });
});

describe("the CLI refuses bad numbers and unknown commands", () => {
  it("rejects a flag that isn't a number and a command it doesn't know", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tla-cli-"));
    writeFileSync(join(dir, "suite.js"), "export default {};");
    await expect(main(["test", "--suite", dir, "--k", "abc"])).rejects.toThrow('--k needs a number (got "abc")');
    await expect(main(["test", "--suite", dir, "--k"])).rejects.toThrow("--k needs a number (got nothing)");
    await expect(main(["test", "--suite", dir, "--k", "0"])).rejects.toThrow("--k needs a whole number of trials, at least 1 (got 0)");
    await expect(main(["test", "--suite", dir, "--min-pass", "2"])).rejects.toThrow('--min-pass needs a number from 0 to 1 (got "2")');
    await expect(main(["bogus"])).rejects.toThrow(/^usage: trust-layer-agent test\|snapshot/);
  });
});

describe("the teaching view", () => {
  it("prints one line per event kind", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    teachingView({ type: "tool", tool: "get_order", ok: true });
    teachingView({ type: "check", event: "action", tool: "refund", check: "big", result: { approve: "Over." } });
    teachingView({ type: "check", event: "reply", check: "claims", result: { block: "No." }, draft: "x" });
    teachingView({ type: "approval", decision: "approved", tool: "refund", ok: true });
    teachingView({ type: "review", result: { allow: true } });
    expect(log.mock.calls.map((c) => c[0])).toEqual(["   · get_order → ok", "   ⏸ parked refund  [big]  Over.", '   ✗ draft not sent  [claims]\n     draft:  "x"\n     reason: No.', "   ✓ approved refund → ok", "   review → ok"]);
    log.mockRestore();
  });
});

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
    expect([err.session.rev, err.session.messages]).toEqual([1, [{ role: "user", text: "charge me 5", turn: 1 }]]);
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

describe("secret inputs", () => {
  const seen: string[] = [];
  const verify = read({ name: "verify_user", description: "Verify.", input: z.object({ accountId: z.string(), pin: z.string() }), secret: ["pin"],
    records: (_o, i) => { seen.push(i.pin); return {}; }, run: ({ pin }) => { seen.push(pin); return { verified: pin === "4417" }; } });
  const pay = write({ name: "pay", description: "Pay.", input: z.object({ amount: z.number(), cvv: z.string() }), secret: ["cvv"], confirm: false, run: ({ cvv }) => { seen.push(cvv); return { paid: true }; } });
  const call = (input: Record<string, unknown>): Step => ({ call: "verify_user", input });
  beforeEach(() => { seen.length = 0; lines.length = 0; });
  it("is [redacted] in the ToolResult, the trace line and the replayed history; run() and records() get the real value", async () => {
    const model = scripted([call({ accountId: "a_1", pin: "4417" }), "Verified.", "Still here."]), a = agent(model, [verify]);
    const t1 = await a.respond(session(), "a_1, pin 4417");
    expect(t1.session.results[0].input).toEqual({ accountId: "a_1", pin: "[redacted]" });
    expect(lines.find((l) => l.type === "tool").input.pin).toBe("[redacted]");
    expect(seen).toEqual(["4417", "4417"]);
    await a.respond(t1.session, "ok");
    expect((model.requests[2].messages.find((m: any) => m.toolCalls) as any).toolCalls[0].input).toEqual({ accountId: "a_1", pin: "[redacted]" });
  });
  it("stays out of a failed call's result and out of a blocked call's trace line", async () => {
    const a = agent(scripted([call({ accountId: 1, pin: "4417" }), call({ accountId: "a_1", pin: "4417" }), "Sorry."]), [verify],
      { checks: [check("second", (e, ctx) => (e.kind === "action" && ctx.results.length ? block("once") : allow()))] });
    const r = await a.respond(session(), "hi");
    expect(r.session.results[0]).toMatchObject({ ok: false, error: { code: "invalid_input" }, input: { accountId: 1, pin: "[redacted]" } });
    expect(lines.find((l) => l.type === "check" && l.event === "action").input).toEqual({ accountId: "a_1", pin: "[redacted]" });
  });
  it("a parked action keeps the value until a person decides, since the tool still has to run; approve() then redacts the record", async () => {
    const a = agent(scripted([{ call: "pay", input: { amount: 5, cvv: "123" } }, "Requested."]), [pay],
      { checks: [check("big", (e) => (e.kind === "action" ? approve("needs a person") : allow()))] });
    const t1 = await a.respond(session(), "pay 5");
    expect(t1.session.approvals[0].input).toEqual({ amount: 5, cvv: "123" });
    const { session: s, result } = await a.approve(t1.session, "p_1");
    expect([s.approvals[0].input, result.input, seen]).toEqual([{ amount: 5, cvv: "[redacted]" }, { amount: 5, cvv: "[redacted]" }, ["123"]]);
  });
  it("decline() redacts the record and the failed result it appends", async () => {
    const a = agent(scripted([{ call: "pay", input: { amount: 5, cvv: "123" } }, "Requested."]), [pay],
      { checks: [check("big", (e) => (e.kind === "action" ? approve("needs a person") : allow()))] });
    const t1 = await a.respond(session(), "pay 5");
    const { session: s, result } = await a.decline(t1.session, "p_1");
    expect([s.approvals[0].input.cvv, result.input.cvv, lines.at(-1).input.cvv]).toEqual(["[redacted]", "[redacted]", "[redacted]"]);
  });
  it("the waiting note shows the model the pending input with the secret redacted", async () => {
    const model = scripted([{ call: "pay", input: { amount: 5, cvv: "123" } }, "Requested.", "Still pending."]);
    const a = agent(model, [pay], { checks: [check("big", (e) => (e.kind === "action" ? approve("needs a person") : allow()))] });
    const t1 = await a.respond(session(), "pay 5");
    await a.respond(t1.session, "done yet?");
    const noteMsg = model.requests[2].messages.find((m: any) => typeof m.content === "string" && m.content.includes("Waiting for a person"));
    expect(noteMsg?.content).toContain('pay {"amount":5,"cvv":"[redacted]"}');
    expect(noteMsg?.content).not.toContain("123");
  });
  it("the placeholder echoed back by the model is refused before validation, so run() never sees it", async () => {
    const a = agent(scripted([call({ accountId: "a_1", pin: "[redacted]" }), "Sorry."]), [verify]);
    const r = await a.respond(session(), "hi");
    expect(r.session.results[0]).toMatchObject({ ok: false, error: { code: "invalid_input", message: `pin: "[redacted]" is a placeholder for an earlier call's value, not a value; ask for it again.` } });
    expect(seen).toEqual([]);
  });
  it("a pending secret is still redacted on decline and in the waiting note when the tool is no longer registered", async () => {
    const parkIt = check("big", (e) => (e.kind === "action" ? approve("needs a person") : allow()));
    const t1 = await agent(scripted([{ call: "pay", input: { amount: 5, cvv: "123" } }, "Requested."]), [pay], { checks: [parkIt] }).respond(session(), "pay 5");
    expect(t1.session.approvals[0].secret).toEqual(["cvv"]);
    const model = scripted(["Still pending."]), later = agent(model, [verify], { checks: [parkIt] });     // pay is gone
    await later.respond(t1.session, "done yet?");
    expect(model.requests[0].messages.at(-1)?.content).toContain('pay {"amount":5,"cvv":"[redacted]"}');
    const { session: s, result } = await later.decline(t1.session, "p_1");
    expect([s.approvals[0].input.cvv, result.input.cvv]).toEqual(["[redacted]", "[redacted]"]);
  });
  it("a reconcile read gets the real input, not the redacted record", async () => {
    const got: unknown[] = [];
    const status = read({ name: "pay_status", description: "Status.", input: z.object({ cvv: z.string() }), run: (i) => { got.push(i); return { paid: true }; } });
    const risky = write({ name: "pay", description: "Pay.", input: z.object({ cvv: z.string() }), secret: ["cvv"], confirm: false, reconcileWith: "pay_status",
      run: () => { throw new ToolError("timeout", "x", { outcome: "unknown" }); } });
    const r = await agent(scripted([{ call: "pay", input: { cvv: "123" } }, "It's paid."]), [risky, status]).respond(session(), "pay");
    expect([got, r.session.results.map((x) => [x.tool, x.ok, x.input.cvv])]).toEqual([[{ cvv: "123" }], [["pay", false, "[redacted]"], ["pay_status", true, "123"]]]);
  });
  it("must name a field the schema has, and can't be bound or the confirm.by field", () => {
    expect(() => read({ name: "x", description: "x", input: z.object({ a: z.string() }), secret: ["b"] as any, run: () => 1 })).toThrow(/secret field "b" is not in the input schema/);
    expect(() => read({ name: "x", description: "x", input: z.object({ a: z.string() }), secret: ["a"], bind: { a: "facts.a" }, run: () => 1 })).toThrow(/can't be bound or a confirm.by field/);
    expect(() => write({ name: "x", description: "x", input: z.object({ a: z.string() }), secret: ["a"], confirm: { commitment: "q", by: "a" }, run: () => 1 })).toThrow(/can't be bound or a confirm.by field/);
  });
});
