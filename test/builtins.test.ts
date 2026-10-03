import { describe, expect, it } from "vitest";
import { builtinChecks, checkPipeline, isAffirmative, isProceed, verificationWarning } from "../src/builtins.js";
import { allow, block, check, handoff, rewrite, runChecks, type CheckEvent } from "../src/checks.js";
import { ctx, failed, quote, tools } from "./fixtures.js";

const only = (name: string) => builtinChecks().filter((c) => c.name === name);
const action = (name: string, input = {}): CheckEvent => ({ kind: "action", tool: tools.find((t) => t.name === name)!, input });

describe("verified_first", () => {
  it("blocks account tools before verification, naming the verifying tool", async () => {
    const { result } = await runChecks(action("get_account"), ctx({ facts: {} }), only("verified_first"));
    expect(result).toEqual({ block: "Verify the customer before using get_account (use verify_customer)." });
  });
  it("allows beforeVerification tools and verified sessions", async () => {
    expect((await runChecks(action("verify_customer"), ctx({ facts: {} }), only("verified_first"))).result).toEqual(allow());
    expect((await runChecks(action("get_account"), ctx({ facts: { verified: true } }), only("verified_first"))).result).toEqual(allow());
  });
  it("is off, with a warning, when no tool can verify", async () => {
    const noVerifier = tools.filter((t) => !t.verifies);
    expect(verificationWarning(noVerifier)).toMatch(/^verified_first is OFF/);
    expect(verificationWarning(tools)).toBeUndefined();
    expect((await runChecks(action("get_account"), ctx({ facts: {}, tools: noVerifier }), only("verified_first"))).result).toEqual(allow());
  });
  it("still applies when the app created the session with verified: false", async () => {
    const noVerifier = tools.filter((t) => !t.verifies);
    const { result } = await runChecks(action("get_account"), ctx({ facts: { verified: false }, tools: noVerifier }), only("verified_first"));
    expect(result).toHaveProperty("block");
  });
});

describe("yes_after_quote", () => {
  it.each(["yes", "Yes!", "yeah go ahead", "ok, do it", "sounds good"])("%s is a yes", (t) => expect(isAffirmative(t)).toBe(true));
  it.each(["no", "not yet", "yes but what's the fee?", "nope", "wait", "is that the final price?"])("%s is not a yes", (t) => expect(isAffirmative(t)).toBe(false));
  it.each(["Can you just switch me?", "go ahead and switch", "please switch me", "do it 👍"])("%s is a request to proceed", (t) => expect(isProceed(t)).toBe(true));
  it.each(["what would it cost?", "Before you change anything, what exactly would it cost me?", "don't switch me yet"])("%s is not", (t) => expect(isProceed(t)).toBe(false));

  it("counts a proceed-request as consent only after the quote was shown in an earlier reply", async () => {
    expect((await run(["c: switch me to Plus", "a: Plus is $29/month. Shall I?", "c: Can you just switch me?"])).result).toEqual(allow());
    expect((await run(["c: switch me to Plus", "a: Let me check.", "c: Can you just switch me?"], [quote({ shownTurn: undefined })])).result).toHaveProperty("block");
    expect((await run(["c: Can you just switch me?"], [])).result).toHaveProperty("block");
    expect((await run(["c: switch me to Plus", "a: Plus is $29/month. Shall I?", "c: what would it cost?"])).result).toHaveProperty("block");
  });

  const run = (say: string[], commitments = [quote()], now?: Date) =>
    runChecks(action("change_plan", { quoteId: "q_1" }), ctx({ say, commitments, now }), only("yes_after_quote"));

  it("allows a write after the quote was shown and the customer said yes", async () => {
    expect((await run(["c: switch me to Plus", "a: Plus is $29/month plus $4.12 today. Go ahead?", "c: yes"])).result).toEqual(allow());
  });
  it("blocks a yes given before the quote was shown", async () => {
    const { result } = await run(["c: yes, switch me to Plus"], [quote({ turn: 1, shownTurn: undefined })]);
    expect(result).toHaveProperty("block");
  });
  it("blocks when the quote was shown in the same turn the yes was given", async () => {
    const { result } = await run(["c: yes switch me", "a: it's $29"], [quote({ shownTurn: 1 })]);
    expect(result).toHaveProperty("block");                       // the last message is the agent's, not a yes
    const { result: r2 } = await runChecks(action("change_plan", { quoteId: "q_1" }),
      ctx({ say: ["c: switch me", "a: let me check", "c: yes"], commitments: [quote({ shownTurn: 2 })] }), only("yes_after_quote"));
    expect(r2).toMatchObject({ block: expect.stringContaining("wait for a yes after it") });
  });
  it("blocks an expired quote", async () => {
    const { result } = await run(["c: switch", "a: $29, ok?", "c: yes"], [quote({ expiresAt: "2026-10-03T00:00:00Z" })]);
    expect(result).toMatchObject({ block: expect.stringContaining("expired") });
  });
  it("blocks a quote that doesn't exist or was used", async () => {
    expect((await run(["c: a", "a: b", "c: yes"], [])).result).toMatchObject({ block: expect.stringContaining("No quote") });
    expect((await run(["c: a", "a: b", "c: yes"], [quote({ status: "used" })])).result).toMatchObject({ block: expect.stringContaining("already used") });
  });
  it("skips writes with confirm: false and all reads", async () => {
    expect((await runChecks(action("open_case"), ctx({ say: ["c: help"] }), only("yes_after_quote"))).result).toEqual(allow());
    expect((await runChecks(action("get_account"), ctx({ say: ["c: help"] }), only("yes_after_quote"))).result).toEqual(allow());
  });
});

describe("handoff_after_failures", () => {
  it("hands off after 2 consecutive failures by default, with a summary", async () => {
    const results = [failed("change_plan"), failed("change_plan")];
    expect((await runChecks({ kind: "reply", text: "hi" }, ctx({ failures: 1, results }), only("handoff_after_failures"))).result).toEqual(allow());
    expect((await runChecks({ kind: "reply", text: "hi" }, ctx({ failures: 2, results }), only("handoff_after_failures"))).result)
      .toEqual({ handoff: "2 consecutive failures (change_plan: billing_unavailable; change_plan: billing_unavailable)." });
  });
});

describe("pipeline", () => {
  const seen: string[] = [];
  const spy = (name: string, r = allow()) => check(name, () => (seen.push(name), r));

  it("runs built-ins, then guardrails, then custom checks", async () => {
    seen.length = 0;
    const chain = checkPipeline({}, [spy("guardrail")], [spy("custom")]);
    expect(chain.map((c) => c.name)).toEqual(["verified_first", "yes_after_quote", "no_unconfirmed_claims", "handoff_after_failures", "guardrail", "custom"]);
    await runChecks(action("get_account"), ctx(), chain);
    expect(seen).toEqual(["guardrail", "custom"]);
  });
  it("actions: the first non-allow wins", async () => {
    seen.length = 0;
    const { result, by } = await runChecks(action("get_account"), ctx(), [spy("a"), spy("b", block("no")), spy("c", handoff("x"))]);
    expect([result, by, seen]).toEqual([{ block: "no" }, "b", ["a", "b"]]);
  });
  it("actions: a rewrite throws", async () => {
    await expect(runChecks(action("get_account"), ctx(), [spy("r", rewrite("x"))])).rejects.toThrow(/replies only/);
  });
  it("replies: rewrites chain, later checks see the new text, block stops", async () => {
    const texts: string[] = [];
    const see = (name: string, r = allow()) => check(name, (e) => (texts.push(e.kind === "reply" ? e.text : ""), r));
    const v = await runChecks({ kind: "reply", text: "one" }, ctx(), [see("a", rewrite("two")), see("b"), see("c", block("stop")), see("d")]);
    expect(texts).toEqual(["one", "two", "two"]);
    expect([v.result, v.by]).toEqual([{ block: "stop" }, "c"]);
    const r = await runChecks({ kind: "reply", text: "one" }, ctx(), [see("a", rewrite("two"))]);
    expect(r.result).toEqual({ rewrite: "two" });
  });
});
