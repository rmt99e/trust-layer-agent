// A fictional subscription app's data and business rules. Plain JavaScript, no framework.
// Tools (tools.js) call these functions; simulations will call them over a fresh seeded copy.
import { ToolError } from "trust-layer-agent";

export const PLANS = {
  starter: { id: "starter", name: "Starter", monthlyPrice: 9, includedCredits: 100 },
  plus: { id: "plus", name: "Plus", monthlyPrice: 29, includedCredits: 500 },
  pro: { id: "pro", name: "Pro", monthlyPrice: 79, includedCredits: 2000 },
};
export const USAGE_PACK = { credits: 100, price: 5 };
export const REFUND_WINDOW_DAYS = 30;

const cycles = (limit, used) => used.map((u, i) => ({ period: `2026-0${7 + i}`, used: u, limit, hitLimit: u >= limit }));
const customer = (id, pin, name, email, phone, address, plan, used, extra = {}) => ({
  id, pin, name, email, phone, address, plan: { ...PLANS[plan], pricing: "standard" }, renewsOn: "2026-10-15",
  usage: cycles(PLANS[plan].includedCredits, used), invoices: [], approvedDiscounts: [], usagePacks: [], ...extra,
});

export const SEED = {
  today: "2026-10-03",
  customers: {
    // Hit the limit in 2 of the last 3 cycles: should be offered an upgrade.
    acc_100: customer("acc_100", "4417", "Dana Ruiz", "dana.ruiz@example.com", "+1 415 555 0101", "12 Oak Street, Springfield", "starter", [100, 64, 100],
      { approvedDiscounts: [{ code: "LOYAL10", percent: 10 }] }),
    // Hit it once: a one-time usage pack is the right answer.
    acc_200: customer("acc_200", "2231", "Lee Park", "lee.park@example.com", "+1 415 555 0102", "48 Pine Avenue, Riverton", "plus", [310, 500, 280]),
    // Uses far less than the plan includes: a cheaper plan fits.
    acc_300: customer("acc_300", "9902", "Sam Ortiz", "sam.ortiz@example.com", "+1 415 555 0103", "7 Elm Road, Lakeside", "pro", [220, 180, 240]),
    // A recent invoice inside the refund window.
    acc_400: customer("acc_400", "5150", "Kim Alvarez", "kim.alvarez@example.com", "+1 415 555 0104", "300 Birch Lane, Fairview", "plus", [120, 90, 150],
      { invoices: [{ id: "inv_401", date: "2026-09-20", amount: 29, status: "paid" }] }),
    // An old invoice outside the refund window.
    acc_500: customer("acc_500", "7788", "Ana Cruz", "ana.cruz@example.com", "+1 415 555 0105", "19 Cedar Drive, Hillcrest", "starter", [40, 55, 30],
      { invoices: [{ id: "inv_501", date: "2026-07-01", amount: 9, status: "paid" }] }),
    // Custom enterprise pricing: always handed to a person.
    acc_600: customer("acc_600", "3030", "Jordan Bell", "jordan.bell@example.com", "+1 415 555 0106", "1 Harbor Way, Bayview", "pro", [1500, 1800, 1700],
      { plan: { id: "enterprise", name: "Enterprise", monthlyPrice: null, includedCredits: 10000, pricing: "custom" } }),
  },
};

const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const money = (n) => Math.round(n * 100) / 100;

export function createStore(seed = SEED) {
  const db = structuredClone(seed);
  let next = 1;
  const id = (prefix) => `${prefix}_${String(next++).padStart(3, "0")}`;
  const account = (accountId) => {
    const c = db.customers[accountId];
    if (!c) throw new ToolError("not_found", "No account with that id.");
    return c;
  };

  return {
    db,
    verify(accountId, pin) {
      const c = db.customers[accountId];
      return c && c.pin === pin ? { verified: true, accountId, name: c.name } : { verified: false, accountId };
    },
    getAccount(accountId) {
      const { pin, usage, invoices, usagePacks, ...rest } = account(accountId);
      return rest;
    },
    getUsage(accountId) {
      const c = account(accountId);
      const hits = c.usage.filter((u) => u.hitLimit).length;
      const cheaper = Object.values(PLANS).find((p) => p.monthlyPrice < c.plan.monthlyPrice && c.usage.every((u) => u.used <= p.includedCredits));
      const suggestion = hits >= 2 ? "upgrade" : hits === 1 ? "usage_pack" : cheaper ? "cheaper_plan" : "none";
      return { cycles: c.usage, limitHitsLast3: hits, suggestion };
    },
    getInvoices(accountId) {
      return { invoices: account(accountId).invoices.map((i) => ({ ...i, refundableUntil: new Date(Date.parse(i.date) + REFUND_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10) })) };
    },
    eligiblePlans(accountId) {
      const c = account(accountId);
      return { plans: Object.values(PLANS).filter((p) => p.id !== c.plan.id) };
    },
    quote(accountId, planId, discountCode) {
      const c = account(accountId), plan = PLANS[planId];
      if (!plan || plan.id === c.plan.id) throw new ToolError("not_eligible", "That plan isn't available for this account.");
      const discount = discountCode ? c.approvedDiscounts.find((d) => d.code === discountCode) : undefined;
      if (discountCode && !discount) throw new ToolError("invalid_discount", "That discount code isn't approved for this account.");
      const monthlyPrice = money(plan.monthlyPrice * (1 - (discount?.percent ?? 0) / 100));
      const diff = monthlyPrice - c.plan.monthlyPrice;
      const q = {
        quoteId: id("q"), planId, planName: plan.name, monthlyPrice,
        proratedCharge: diff > 0 ? money((diff * days(db.today, c.renewsOn)) / 30) : 0,
        monthlySavings: diff < 0 ? money(-diff) : 0, monthlyIncrease: diff > 0 ? money(diff) : 0,
        effectiveDate: db.today, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
      (db.quotes ??= {})[q.quoteId] = { ...q, accountId };
      return q;
    },
    changePlan(accountId, quoteId) {
      const q = db.quotes?.[quoteId];
      if (!q || q.accountId !== accountId) throw new ToolError("not_found", "No such quote for this account.");
      if (process.env.FAIL_CHANGE_PLAN === "1") throw new ToolError("billing_unavailable", "The billing system rejected the change. Nothing was changed.");
      account(accountId).plan = { ...PLANS[q.planId], monthlyPrice: q.monthlyPrice, pricing: "standard" };
      return { status: "active", planName: q.planName, monthlyPrice: q.monthlyPrice, effectiveDate: q.effectiveDate };
    },
    refund(accountId, invoiceId, amount) {
      const inv = account(accountId).invoices.find((i) => i.id === invoiceId);
      if (!inv) throw new ToolError("not_found", "No such invoice on this account.");
      if (inv.status === "refunded") throw new ToolError("already_refunded", "This invoice was already refunded.");
      if (days(inv.date, db.today) > REFUND_WINDOW_DAYS) throw new ToolError("outside_refund_window", `This invoice is older than ${REFUND_WINDOW_DAYS} days.`);
      const refund = amount ?? inv.amount;
      if (refund <= 0 || refund > inv.amount) throw new ToolError("invalid_amount", `Refunds can be up to the invoice amount (${inv.amount}).`);
      inv.status = "refunded";
      return { refundId: id("rf"), invoiceId, amount: refund, status: "refunded" };
    },
    addUsagePack(accountId) {
      const pack = { packId: id("pk"), credits: USAGE_PACK.credits, price: USAGE_PACK.price, validUntil: account(accountId).renewsOn };
      account(accountId).usagePacks.push(pack);
      return pack;
    },
    openCase(accountId, summary) {
      return { caseId: id("case"), accountId, summary, status: "open" };
    },
  };
}
