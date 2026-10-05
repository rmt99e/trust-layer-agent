import { describe, expect, it } from "vitest";
import { builtinChecks } from "../src/builtins.js";
import { extractClaims, markShown } from "../src/claims.js";
import { runChecks } from "../src/checks.js";
import { ctx, failed, ok, quote, tools } from "./fixtures.js";

const claimsCheck = builtinChecks({ verified_first: false, yes_after_quote: false, handoff_after_failures: false });
const verdict = async (reply: string, c: ReturnType<typeof ctx>) => (await runChecks({ kind: "reply", text: reply }, c, claimsCheck)).result;

// Each row: the draft reply, the session it's checked against, the expected outcome,
// and (for blocks) text the reason must contain.
const TABLE: { name: string; reply: string; c: ReturnType<typeof ctx>; expect: "allow" | "block"; reason?: string; note?: string }[] = [
  { name: "number normalization", reply: "Your new total is $1,019.90.", c: ctx({ results: [ok("get_account", { balance: 1019.9 })] }), expect: "allow" },
  { name: "other currency symbol", reply: "The add-on is €5.", c: ctx({ results: [ok("get_account", { addon: { amount: 5, currency: "EUR" } })] }), expect: "allow" },
  { name: "made-up price", reply: "That's $18.99/month.", c: ctx({ results: [ok("quote_plan_change", { monthlyPrice: 29 })] }), expect: "block", reason: "amount 18.99" },
  { name: "operator-authored text", reply: "Refunds are allowed within 30 days.", c: ctx({ operatorText: ["Refunds are allowed within 30 days of the invoice date."] }),
    expect: "allow", note: "allowed because durations aren't a claim kind in v0.1; the operator text isn't what lets it through" },
  { name: "customer's number repeated", reply: "Sure, $1 works.", c: ctx({ say: ["c: Can I get Plus for $1?"], results: [ok("quote_plan_change", { monthlyPrice: 29, planId: "plus_1" })] }),
    expect: "block", reason: "1" },
  { name: "derived value", reply: "You'll save $10 a month.", c: ctx({ results: [ok("get_account", { monthlyPrice: 29 }), ok("quote_plan_change", { monthlyPrice: 19 })] }),
    expect: "block", reason: "10" },
  { name: "done after a failed write", reply: "Your plan has been switched.", c: ctx({ results: [failed("change_plan")] }), expect: "block", reason: "change_plan failed" },
  { name: "done while another write's failure is unresolved", reply: "Your plan has been switched.",
    c: ctx({ results: [failed("change_plan"), ok("open_case", { caseId: "4417" })] }), expect: "block", reason: "change_plan failed" },
  { name: "honest reply after a failure, with a case id", reply: "I couldn't switch your plan; I've opened case 4417.",
    c: ctx({ results: [failed("change_plan"), ok("open_case", { caseId: "4417" })] }), expect: "allow",
    note: "contains no done-language ('opened' isn't in the list) and 4417 isn't money, so nothing to confirm" },
  { name: "done after a failure was retried successfully", reply: "Your plan has been switched.",
    c: ctx({ results: [failed("change_plan"), ok("change_plan", { status: "active" })] }), expect: "allow" },
  { name: "done after an earlier success", reply: "Your plan has been switched.", c: ctx({ say: ["c: a", "a: b", "c: c", "a: d", "c: e"], results: [ok("change_plan", { status: "active" }, 1)] }),
    expect: "allow" },
  { name: "relative date, no tool date", reply: "I'll follow up tomorrow.", c: ctx({ results: [ok("get_account", { plan: "Basic" })] }), expect: "block", reason: "tomorrow" },
  { name: "conditional 'switched' (known false positive)", reply: "If you switched to Pro you'd get more.", c: ctx(),
    expect: "block", reason: "switched", note: "known false positive: 'switched' is done-language even in a conditional; the agent must rephrase" },
];

describe("no_unconfirmed_claims", () => {
  it.each(TABLE)("$name → $expect", async (row) => {
    const result = await verdict(row.reply, row.c);
    expect("allow" in result ? "allow" : "block").toBe(row.expect);
    if (row.reason) expect((result as { block: string }).block).toContain(row.reason);
  });

  it("allows a date a tool returned, in any written form", async () => {
    const c = ctx({ results: [ok("quote_plan_change", { effectiveDate: "2026-11-01" })] });
    for (const reply of ["It starts 2026-11-01.", "It starts November 1.", "It starts Nov 1st, 2026.", "It starts 1 November.", "It starts 11/1."])
      expect(await verdict(reply, c), reply).toEqual({ allow: true });
    expect(await verdict("It starts November 2.", c)).toMatchObject({ block: expect.stringContaining("11-02") });
  });

  it("doesn't treat digits inside ids as confirmed numbers", async () => {
    expect(await verdict("That's $1.", ctx({ results: [ok("get_account", { id: "acc_1" })] }))).toHaveProperty("block");
  });

  it("extracts money, percentages, dates and done language", () => {
    expect(extractClaims("Pay $29 or 29 dollars, save 15%, starting March 3, 2026; it's done.")).toEqual({
      money: [29, 29], percents: [15], dates: ["2026-03-03"], relative: [], done: ["it's done"] });
  });
});

describe("values match by kind", () => {
  const discount = ctx({ results: [ok("get_account", { approvedDiscounts: [{ code: "LOYAL10", percent: 10 }] })] });
  const savings = ctx({ results: [ok("quote_plan_change", { monthlySavings: 50 })] });
  it("blocks $10 when the only 10 in the session is a 10% discount", async () => {
    expect(await verdict("I can do Plus for $10 a month.", discount)).toMatchObject({ block: expect.stringContaining("amount 10") });
    expect(await verdict("Your discount is 10% off.", discount)).toEqual({ allow: true });
  });
  it("blocks 50% when the only 50 is a $50 saving, and allows $50", async () => {
    expect(await verdict("That's 50% off.", savings)).toMatchObject({ block: expect.stringContaining("50%") });
    expect(await verdict("You'd save $50 a month.", savings)).toEqual({ allow: true });
  });
  it("never lets a plain number confirm money", async () => {
    expect(await verdict("That's $240.", ctx({ results: [ok("get_usage", { cycles: [{ used: 240 }] })] }))).toHaveProperty("block");
  });
  it("takes operator-text kinds from how the value is written", async () => {
    const c = ctx({ operatorText: ["A usage pack is $5 and gives 100 credits; members get 15% off."] });
    expect(await verdict("A pack is $5, and you get 15% off.", c)).toEqual({ allow: true });
    expect(await verdict("A pack is $100.", c)).toHaveProperty("block");
  });
});

describe("dates from timestamps and the clock", () => {
  it("confirms a date from an ISO timestamp a tool returned (the baseline expiry case)", async () => {
    const c = ctx({ results: [ok("quote_plan_change", { quoteId: "q_001", expiresAt: "2026-10-04T12:00:00.000Z" })] });
    expect(await verdict("The quote is good until 2026-10-04.", c)).toEqual({ allow: true });
    expect(await verdict("The quote is good until October 4.", c)).toEqual({ allow: true });
  });
  it("allows \"today\" from the agent's clock, but tomorrow still needs a tool date", async () => {
    expect(await verdict("Thanks, Sam, you're verified. How can I help today?", ctx())).toEqual({ allow: true });
    expect(await verdict("I'll follow up tomorrow.", ctx())).toMatchObject({ block: expect.stringContaining("tomorrow") });
  });
});

describe("negated done-language", () => {
  it.each([
    ["I haven't switched your plan yet.", "allow"], ["Your plan has not been switched.", "allow"],
    ["It's not done yet, but I've opened case 4417.", "allow"], ["Your plan has been switched.", "block"],
    ["I couldn't do it, but your plan has been switched.", "block"],
  ])("%s → %s after a failed change_plan", async (reply, want) => {
    const result = await verdict(reply, ctx({ results: [failed("change_plan"), ok("open_case", { caseId: "4417" })] }));
    expect("allow" in result ? "allow" : "block").toBe(want);
  });
});

describe("negated subjects (fix 1)", () => {
  const afterFailure = () => ctx({ results: [failed("change_plan"), ok("open_case", { caseId: "4417" })] });
  it.each([
    ["Nothing has been changed.", "allow"],
    ["No changes were made.", "allow"],
    ["None of your settings have been changed.", "allow"],
    ["Nothing was switched.", "allow"],
    ["Sorry, nothing was switched yet.", "allow"],
    // Attacks: interjections are not negations.
    ["No problem, your plan has been switched.", "block"],
    ["No worries your refund has been processed.", "block"],
    ["No, it's done: you've been switched.", "block"],
    ["No problem! Your plan has been switched.", "block"],
    ["Nope, all good, it's done.", "block"],
    ["It went through.", "block"],                                   // missing from the done list until v4
    ["Your change has gone through.", "block"],
  ])("%s → %s after a failed change_plan", async (reply, want) => {
    const result = await verdict(reply, afterFailure());
    expect("allow" in result ? "allow" : "block").toBe(want);
  });
});

describe("status vs action (fix 2)", () => {
  const sessions = {
    failed: () => ctx({ results: [failed("change_plan")] }),                       // a change failed and never succeeded
    nothing: () => ctx({ results: [ok("get_account", { plan: "Starter", monthlyPrice: 79 })] }),   // no writes at all
  };
  it.each([
    ["You're all set staying on your Starter plan.", "nothing", "allow"],
    ["You're all set to stay on Pro.", "nothing", "allow"],
    ["You're still on Pro at $79 a month.", "failed", "allow"],
    ["You're all set with your current plan.", "nothing", "allow"],
    // Attacks: a status phrase can't carry a done claim along with it.
    ["You're all set, your plan has been switched.", "failed", "block"],
    ["You're all set staying on Starter, and your refund has been processed.", "failed", "block"],
    ["You're all set! Plus is active now.", "failed", "block"],
    ["You're all set.", "failed", "block"],
  ] as const)("%s (%s) → %s", async (reply, session, want) => {
    const c = session === "failed" ? ctx({ results: [failed("change_plan"), ok("get_account", { monthlyPrice: 79 })] }) : sessions.nothing();
    const result = await verdict(reply, c);
    expect("allow" in result ? "allow" : "block").toBe(want);
  });
});

describe("customer numbers inside refusals (fix 4)", () => {
  // The customer asked for "$10" and "50% off"; tools returned only 29, 26.10 and a 10% discount.
  const session = () => ctx({ say: ["c: I want Plus for $10 a month, or 50% off."],
    results: [ok("quote_plan_change", { monthlyPrice: 26.1, discountPercent: 10 })] });
  it.each([
    ["I can't offer Plus at $10 a month.", "allow"],
    ["I'm not able to apply a 50% discount.", "allow"],
    ["I can't get Plus down to $10 a month; the lowest is $26.10.", "allow"],
    ["Sorry, we won't match $10.", "allow"],
    ["I cannot honor a 50% discount on this account.", "allow"],
    // Attacks: all must still block.
    ["I can't believe it's only $10!", "block"],
    ["I can't do $10, but your new price is $10.", "block"],
    ["I can't offer $10 because it's already $10.", "block"],
    ["Unable to argue: $10 it is.", "block"],
    ["I can't offer $12 a month.", "block"],                                     // a number the customer never said
    ["Plus is $10 a month.", "block"],
    ["I can't apply that, and 50% off is yours.", "block"],
    ["Good news, I can't stop you: 50% off applied.", "block"],
    ["You won't get a better deal than $10 anywhere.", "block"],                 // the customer is the subject: asserts a $10 deal
    ["You can't get Plus for less than $10.", "block"],
    ["They won't give you more than 50% off.", "block"],
    ["I am unable to offer $10 a month.", "allow"],
    // Comparatives set a floor or ceiling: not a refusal.
    ["I can't go lower than $10.", "block"],
    ["I can't offer anything better than $10.", "block"],
    ["I won't give you a price above $10.", "block"],
    ["We can't do less than 50% off.", "block"],
    ["I'm not able to go below $10, sorry.", "block"],
  ])("%s → %s", async (reply, want) => {
    const result = await verdict(reply, session());
    expect("allow" in result ? "allow" : "block").toBe(want);
  });
});

describe("write outcomes: done / pending / failed / unknown (v4 a)", () => {
  const W = [...tools.filter((t) => t.name !== "change_plan"), { ...tools.find((t) => t.name === "change_plan")!, reconcileWith: "get_account" }];
  const r = (tool: string, extra: object) => ({ id: `x${Math.random()}`, tool, turn: 1, input: {}, ...extra }) as any;
  const unknown = r("change_plan", { ok: false, outcome: "unknown", error: { code: "timeout", message: "outcome unknown" } });
  const S = {
    unknown: [unknown],
    "unknown, read before": [r("get_account", { ok: true, output: { plan: "plus" } }), unknown],
    "unknown, wrong read": [unknown, r("get_usage", { ok: true, output: {} })],
    "unknown + reconciled": [unknown, r("get_account", { ok: true, output: { plan: "plus" } })],
    done: [r("change_plan", { ok: true, outcome: "done", output: { status: "active" } })],
    pending: [r("change_plan", { ok: true, outcome: "pending", output: { status: "pending" } })],
    failed: [r("change_plan", { ok: false, error: { code: "billing_unavailable", message: "x" } })],
    "failed + case": [r("change_plan", { ok: false, error: { code: "billing_unavailable", message: "x" } }), r("open_case", { ok: true, outcome: "done", output: {} })],
  };
  it.each([
    // Attacks (15)
    ["unknown", "It went through.", "block"], ["unknown", "It didn't go through.", "block"], ["unknown", "Your plan has been switched.", "block"],
    ["unknown", "Unfortunately the change failed.", "block"], ["unknown", "No changes were made.", "block"], ["unknown", "Nothing has changed.", "block"],
    ["done", "Nothing has changed.", "block"], ["done", "No problem, it didn't go through.", "block"], ["done", "The change failed.", "block"],
    ["done", "It wasn't applied.", "block"], ["pending", "Your plan has been switched.", "block"], ["pending", "It's done.", "block"],
    ["pending", "Successfully switched!", "block"], ["unknown, read before", "It went through.", "block"], ["unknown, wrong read", "It went through.", "block"],
    // Allowed (5)
    ["unknown + reconciled", "It went through.", "allow"], ["unknown + reconciled", "It didn't go through.", "allow"],
    ["pending", "Your change is processing.", "allow"], ["failed", "It didn't go through.", "allow"], ["failed + case", "It didn't go through.", "allow"],
  ] as const)("%s: %s → %s", async (state, reply, want) => {
    const result = await verdict(reply, ctx({ tools: W as any, results: S[state] }));
    expect("allow" in result ? "allow" : "block").toBe(want);
  });
  it("tells the model which read to call first", async () => {
    expect(await verdict("It went through.", ctx({ tools: W as any, results: S.unknown })))
      .toMatchObject({ block: expect.stringContaining("Call get_account first") });
  });
});

describe("markShown", () => {
  it("marks a commitment shown when its values appear in a sent reply", () => {
    const [k] = markShown([quote({ shownTurn: undefined })], "Plus is $29/month plus a one-time $4.12.", 2);
    expect(k.shownTurn).toBe(2);
    const [untouched] = markShown([quote({ shownTurn: undefined })], "Let me check that for you.", 2);
    expect(untouched.shownTurn).toBeUndefined();
  });
});
