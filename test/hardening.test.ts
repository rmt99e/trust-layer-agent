// Edge-of-pipeline behaviour: what happens when a tool, the model or the stored data misbehaves.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, allow, approve, check, createSession, handoff, jsonl, loadSession, read, teachingView, ToolError, write, z, type Model, type ModelResponse, type Session } from "../src/index.js";
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
  ])("a draft %s is refused and the model writes again", async (_n, step, reason) => {
    lines.length = 0;
    const model = raw([step, "Your order has shipped."]);
    const r = await agent(model, [order]).respond(session(), "where is it?");
    expect(r.reply).toBe("Your order has shipped.");
    expect(lines.find((l) => l.type === "check" && l.event === "reply")).toMatchObject({ check: "complete_reply", result: { block: reason } });
    expect(model.requests[1].messages.at(-1)!.content).toContain(`That draft was not sent. ${reason}`);
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
    expect(() => s.forget!("../escaped")).not.toThrow();
    expect(require("node:fs").existsSync(join(dir, "..", "escaped.jsonl"))).toBe(false);
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
  it("approve() refuses a quote that expired while parked, as a commitment_unusable failure", async () => {
    let clock = new Date("2026-10-03T12:00:00Z");
    const { a, t2 } = await parkIt(() => clock);
    clock = new Date("2026-10-03T14:00:00Z");
    const { result, session: after } = await a.approve(t2.session, "p_1");
    expect(result).toMatchObject({ ok: false, error: { code: "commitment_unusable", message: 'quote "q_1" expired before it was approved.' } });
    expect(after.commitments[0].status).toBe("open");
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
  it('"29 a month" is a price claim', () => {
    expect(extractClaims("Plus is 29 a month, or 290 per year.").money).toEqual([29, 290]);
  });
});

describe("the CLI refuses bad numbers and unknown commands", () => {
  it("rejects a flag that isn't a number and a command it doesn't know", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tla-cli-"));
    writeFileSync(join(dir, "suite.js"), "export default {};");
    await expect(main(["test", "--suite", dir, "--k", "abc"])).rejects.toThrow('--k needs a number (got "abc")');
    await expect(main(["test", "--suite", dir, "--k", "0"])).rejects.toThrow("--k needs a whole number of trials (got 0)");
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
