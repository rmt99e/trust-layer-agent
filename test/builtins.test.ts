import { describe, expect, it } from "vitest";
import { builtinChecks, checkPipeline, isAffirmative, isProceed, verificationWarning } from "../src/builtins.js";
import { allow, approve, block, check, handoff, rewrite, runChecks, type CheckEvent, type ToolInfo } from "../src/checks.js";
import { ctx, failed, ok, quote, tools } from "./fixtures.js";

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
    expect(verificationWarning(noVerifier)).toContain("doesn't apply to sessions your app creates with createSession({ facts: { verified } })");
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
  it("lower-cases custom phrases before matching", () => {
    expect(isAffirmative("Make It So", ["Make It So"])).toBe(true);
    expect(isAffirmative("make it so", ["MAKE IT SO"])).toBe(true);
  });
  it.each(["no", "not yet", "yes but what's the fee?", "nope", "wait", "is that the final price?"])("%s is not a yes", (t) => expect(isAffirmative(t)).toBe(false));
  it.each(["Can you just switch me?", "go ahead and switch", "please switch me", "do it 👍"])("%s is a request to proceed", (t) => expect(isProceed(t)).toBe(true));
  it.each(["what would it cost?", "Before you change anything, what exactly would it cost me?", "don't switch me yet"])("%s is not", (t) => expect(isProceed(t)).toBe(false));

  describe("more consent phrases (fix 3)", () => {
    const shown = (said: string) => run(["c: switch me to Plus", "a: Plus is $29/month. Shall I?", `c: ${said}`]);
    const notShown = (said: string) => run(["c: switch me to Plus", "a: Let me check.", `c: ${said}`], [quote({ shownTurn: undefined })]);
    it.each(["sounds good", "sounds good to me, I'd like to go with that", "let's go with that", "I'll take it"])
      ("after a shown quote, %s → yes", async (said) => expect((await shown(said)).result).toEqual(allow()));
    // Attacks.
    it.each(["doesn't sound good", "sounds good but what's the fee?", "I won't take it", "I don't think I'll take it", "let's not go with that"])
      ("after a shown quote, %s → not a yes", async (said) => expect((await shown(said)).result).toHaveProperty("block"));
    it.each(["sounds good", "sounds good to me, I'd like to go with that", "let's go with that", "I'll take it"])
      ("before the quote was shown, %s → not a yes", async (said) => expect((await notShown(said)).result).toHaveProperty("block"));
  });

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
    expect(chain.map((c) => c.name)).toEqual(["verified_first", "yes_after_quote", "no_unconfirmed_claims", "handoff_after_failures", "no_repeated_writes", "no_invented_inputs", "guardrail", "custom"]);
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
  it("actions: approve is a non-allow result, named; replies: approve throws", async () => {
    const { result, by } = await runChecks(action("change_plan"), ctx(), [spy("a"), spy("ask", approve("Over the limit.")), spy("c")]);
    expect([result, by]).toEqual([{ approve: "Over the limit." }, "ask"]);
    await expect(runChecks({ kind: "reply", text: "hi" }, ctx(), [spy("r", approve("x"))])).rejects.toThrow(/actions only/);
  });
  it("replies: rewrites chain, later checks see the new text, block stops", async () => {
    const texts: string[] = [];
    const see = (name: string, r = allow()) => check(name, (e) => (texts.push(e.kind === "reply" ? e.text : ""), r));
    const v = await runChecks({ kind: "reply", text: "one" }, ctx(), [see("a", rewrite("two")), see("b"), see("c", block("stop")), see("d")]);
    expect(texts).toEqual(["one", "two", "two"]);
    expect([v.result, v.by]).toEqual([{ block: "stop" }, "c"]);
    const r = await runChecks({ kind: "reply", text: "one" }, ctx(), [see("a", rewrite("two"))]);
    expect(r.result).toEqual({ rewrite: "two" });
    expect(r.by).toBe("a");                                         // the rewriting check is named
  });
});

describe("no_repeated_writes (v4 b)", () => {
  const W = (name: string, extra = {}) => ({ name, kind: "write" as const, confirm: false as const, ...extra });
  const done = (tool: string, turn: number) => ({ id: "c", tool, turn, ok: true, input: {}, output: { caseId: "case_002" } });
  const go = (tool: any, results: any[], say = ["c: help", "a: ok", "c: please"]) =>
    runChecks({ kind: "action", tool, input: {} }, ctx({ say, results, tools: [tool] }), only("no_repeated_writes"));
  it.each([
    // Attacks (4)
    ["same write, same turn", W("open_case"), [done("open_case", 2)], "block"],
    ["same write twice before, same turn", W("open_case"), [done("open_case", 2), done("open_case", 2)], "block"],
    ["a write that changes state", W("change_plan"), [done("change_plan", 2)], "block"],
    ["refund twice in a turn", W("refund_invoice"), [done("refund_invoice", 2)], "block"],
    // Allowed (3)
    ["same write, earlier turn", W("open_case"), [done("open_case", 1)], "allow"],
    ["declared repeatable", W("open_case", { repeatable: true }), [done("open_case", 2)], "allow"],
    ["the earlier call failed", W("change_plan"), [{ ...done("change_plan", 2), ok: false }], "allow"],
  ] as const)("%s → %s", async (_n, tool, results, want) => {
    const { result } = await go(tool, results as any);
    expect("allow" in result ? "allow" : "block").toBe(want);
  });
  it("puts the prior result in the block reason", async () => {
    expect((await go(W("open_case"), [done("open_case", 2)])).result).toEqual({
      block: `open_case already succeeded this turn (result: {"caseId":"case_002"}). Don't call it again; use that result.` });
  });
});

describe("no retry of an unknown or pending write in the same turn (v4.1 fix 1)", () => {
  const W = (name: string, extra = {}) => ({ name, kind: "write" as const, confirm: false as const, reconcileWith: "get_account", ...extra });
  const call = (tool: string, turn: number, extra: object) => ({ id: "c", tool, turn, input: {}, ...extra });
  const timeout = (tool: string, turn = 2) => call(tool, turn, { ok: false, outcome: "unknown", error: { code: "timeout", message: "x" } });
  const pending = (tool: string, turn = 2) => call(tool, turn, { ok: true, outcome: "pending", output: { status: "pending" } });
  const failedCall = (tool: string, turn = 2) => call(tool, turn, { ok: false, error: { code: "declined", message: "x" } });
  const go = (tool: any, results: any[]) =>
    runChecks({ kind: "action", tool, input: {} }, ctx({ say: ["c: help", "a: ok", "c: please"], results, tools: [tool] }), only("no_repeated_writes"));
  it.each([
    // Attacks (5)
    ["timeout, then the same write, same turn", W("change_plan"), [timeout("change_plan")], "block"],
    ["pending, then the same write, same turn", W("change_plan"), [pending("change_plan")], "block"],
    ["timeout, then the same repeatable write", W("open_case", { repeatable: true }), [timeout("open_case")], "block"],
    ["timeout + a reconcile read, then a retry, same turn", W("change_plan"), [timeout("change_plan"), call("get_account", 2, { ok: true, output: {} })], "block"],
    ["failure, then timeout, then retry, same turn", W("change_plan"), [failedCall("change_plan"), timeout("change_plan")], "block"],
    // Allowed (3)
    ["known failure, then a retry", W("change_plan"), [failedCall("change_plan")], "allow"],
    ["timeout, then a retry in a later turn", W("change_plan"), [timeout("change_plan", 1)], "allow"],
    ["timeout, then a different write", W("open_case"), [timeout("change_plan")], "allow"],
  ] as const)("%s → %s", async (_n, tool, results, want) => {
    const { result } = await go(tool, results as any);
    expect("allow" in result ? "allow" : "block").toBe(want);
  });
  it("tells the model the outcome is unknown and which read to call", async () => {
    expect((await go(W("change_plan"), [timeout("change_plan")])).result).toEqual({
      block: "change_plan's last call this turn has an unknown outcome and may already have applied. Don't retry it; call get_account to check what happened." });
  });
});

describe("no_invented_inputs", () => {
  const search: ToolInfo = { name: "search_records", kind: "read", fromCustomer: ["name", "city", "aliases"] };
  const run = (input: Record<string, any>, say: string[], facts: Record<string, any> = { verified: true }) =>
    runChecks({ kind: "action", tool: search, input }, ctx({ say, facts, tools: [...tools, search] }), only("no_invented_inputs"));
  const said = ["c: Hi, I'm Dana Whitfield-Ortiz from Springfield.  I also go by D. Whitfield; I'm 34."];

  it.each([
    ["the exact words", { name: "Dana Whitfield-Ortiz", city: "Springfield" }],
    ["any case and spacing", { name: "dana  whitfield-ortiz" }],
    ["a number the customer gave, as a number", { aliases: [34] }],
    ["every element of a list", { aliases: ["D. Whitfield", "Dana"] }],
    ["a value from a session fact", { city: "Riverton" }],
    ["a fact in another case", { city: "RIVERTON" }],
    ["an empty value", { city: " " }],
    ["an input the tool doesn't declare fromCustomer", { depth: "deep" }],
  ])("allows %s", async (_n, input) => expect((await run(input, said, { verified: true, city: "Riverton" })).result).toEqual(allow()));

  // Attacks: a model filling in what it guessed, found in a tool result, or lifted from its own earlier reply.
  it.each([
    ["an invented value", { name: "Dana Whitfield-Ortiz", city: "Shelbyville" }, "Shelbyville"],
    ["a fragment of a longer word", { name: "Dana Whit" }, "Dana Whit"],
    ["a name inside a longer one", { aliases: ["Ortiz-Smith"] }, "Ortiz-Smith"],
    ["one bad element in a list", { aliases: ["Dana", "Danielle"] }, "Danielle"],
    ["a value only the agent said", { city: "Capital City" }, "Capital City"],
  ])("blocks %s", async (_n, input, bad) => {
    const say = [...said, "a: Is that Capital City?", "c: no"];
    expect((await run(input, say)).result).toEqual({ block: `The customer never said "${bad}" (${Object.keys(input).at(-1)} in search_records). Use only values the customer gave, or ask them.` });
  });
  it("never takes a value from a tool result", async () => {
    const c = ctx({ say: said, results: [ok("get_account", { city: "Shelbyville" })], tools: [...tools, search] });
    expect((await runChecks({ kind: "action", tool: search, input: { city: "Shelbyville" } }, c, only("no_invented_inputs"))).result).toHaveProperty("block");
  });
  it("ignores tools without fromCustomer, and can be turned off", async () => {
    expect((await run({ name: "x" }, said)).result).toHaveProperty("block");
    expect((await runChecks(action("get_account", { name: "x" }), ctx({ say: said }), only("no_invented_inputs"))).result).toEqual(allow());
    expect(builtinChecks({ no_invented_inputs: false }).map((c) => c.name)).not.toContain("no_invented_inputs");
  });
});
