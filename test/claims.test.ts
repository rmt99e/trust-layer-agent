import { describe, expect, it } from "vitest";
import { builtinChecks } from "../src/builtins.js";
import { extractClaims, markShown } from "../src/claims.js";
import { runChecks } from "../src/checks.js";
import { ctx, failed, ok, quote } from "./fixtures.js";

const claimsCheck = builtinChecks({ verified_first: false, yes_after_quote: false, handoff_after_failures: false });
const verdict = async (reply: string, c: ReturnType<typeof ctx>) => (await runChecks({ kind: "reply", text: reply }, c, claimsCheck)).result;

// Each row: the draft reply, the session it's checked against, the expected outcome,
// and (for blocks) text the reason must contain.
const TABLE: { name: string; reply: string; c: ReturnType<typeof ctx>; expect: "allow" | "block"; reason?: string; note?: string }[] = [
  { name: "number normalization", reply: "Your new total is $1,019.90.", c: ctx({ results: [ok("get_account", { balance: 1019.9 })] }), expect: "allow" },
  { name: "other currency symbol", reply: "The add-on is €5.", c: ctx({ results: [ok("get_account", { addon: { amount: 5, currency: "EUR" } })] }), expect: "allow" },
  { name: "made-up price", reply: "That's $18.99/month.", c: ctx({ results: [ok("quote_plan_change", { monthlyPrice: 29 })] }), expect: "block", reason: "18.99" },
  { name: "operator-authored text", reply: "Refunds are allowed within 30 days.", c: ctx({ operatorText: ["Refunds are allowed within 30 days of the invoice date."] }),
    expect: "allow", note: "allowed because durations aren't a claim kind in v0.1; the operator text isn't what lets it through" },
  { name: "customer's number repeated", reply: "Sure, $1 works.", c: ctx({ say: ["c: Can I get Plus for $1?"], results: [ok("quote_plan_change", { monthlyPrice: 29, planId: "plus_1" })] }),
    expect: "block", reason: "1" },
  { name: "derived value", reply: "You'll save $10 a month.", c: ctx({ results: [ok("get_account", { monthlyPrice: 29 }), ok("quote_plan_change", { monthlyPrice: 19 })] }),
    expect: "block", reason: "10" },
  { name: "done after a failed write", reply: "Your plan has been switched.", c: ctx({ results: [failed("change_plan")] }), expect: "block", reason: "change_plan failed" },
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

describe("markShown", () => {
  it("marks a commitment shown when its values appear in a sent reply", () => {
    const [k] = markShown([quote({ shownTurn: undefined })], "Plus is $29/month plus a one-time $4.12.", 2);
    expect(k.shownTurn).toBe(2);
    const [untouched] = markShown([quote({ shownTurn: undefined })], "Let me check that for you.", 2);
    expect(untouched.shownTurn).toBeUndefined();
  });
});
