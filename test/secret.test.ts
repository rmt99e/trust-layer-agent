// `secret` input fields: real for run(), records() and the checks; [redacted] everywhere the session, traces or history keep them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allow, approve, block, check, read, ToolError, write, z } from "../src/index.js";
import { scripted, type Step } from "./fake-model.js";
import { agent, lines, session } from "./harness.js";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); lines.length = 0; });

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
    const status = read({ name: "pay_status", description: "Status.", input: z.object({ cvv: z.string() }), secret: ["cvv"], run: (i) => { got.push(i); return { paid: true }; } });
    const risky = write({ name: "pay", description: "Pay.", input: z.object({ cvv: z.string() }), secret: ["cvv"], confirm: false, reconcileWith: "pay_status",
      run: () => { throw new ToolError("timeout", "x", { outcome: "unknown" }); } });
    const r = await agent(scripted([{ call: "pay", input: { cvv: "123" } }, "It's paid."]), [risky, status]).respond(session(), "pay");
    expect([got, r.session.results.map((x) => [x.tool, x.ok, x.input.cvv])]).toEqual([[{ cvv: "123" }], [["pay", false, "[redacted]"], ["pay_status", true, "[redacted]"]]]);
    const leaky = read({ name: "pay_status", description: "Status.", input: z.object({ cvv: z.string() }), run: () => ({}) });
    expect(() => agent(scripted([]), [risky, leaky])).toThrow(/reconcileWith "pay_status" takes secret field "cvv" but doesn't declare it secret/);
  });
  it("must name a field the schema has, and can't be bound or the confirm.by field", () => {
    expect(() => read({ name: "x", description: "x", input: z.object({ a: z.string() }), secret: ["b"] as any, run: () => 1 })).toThrow(/secret field "b" is not in the input schema/);
    expect(() => read({ name: "x", description: "x", input: z.object({ a: z.string() }), secret: ["a"], bind: { a: "facts.a" }, run: () => 1 })).toThrow(/can't be bound or a confirm.by field/);
    expect(() => write({ name: "x", description: "x", input: z.object({ a: z.string() }), secret: ["a"], confirm: { commitment: "q", by: "a" }, run: () => 1 })).toThrow(/can't be bound or a confirm.by field/);
  });
});

