// Tool declarations over the store. The store decides; the model only sees what `visible` (or the
// personal-data defaults) let through, and never sees or chooses the account id once verified.
import { read, write, z } from "trust-layer-agent";

const account = { accountId: z.string() };
const bind = { accountId: "facts.accountId" };

export function makeTools(store) {
  return [
    read({
      name: "verify_customer", description: "Verify the customer with their account id and PIN.",
      input: z.object({ accountId: z.string(), pin: z.string() }), beforeVerification: true, verifies: true,
      visible: ["verified", "name"],
      records: (o) => (o.verified ? { facts: { verified: true, accountId: o.accountId } } : {}),
      run: ({ accountId, pin }) => store.verify(accountId, pin),
    }),
    read({
      name: "get_account", description: "The customer's account: plan, price, renewal date and approved discounts.",
      input: z.object(account), bind,                     // no visible list: email, phone and address are hidden by default
      run: ({ accountId }) => store.getAccount(accountId),
    }),
    read({
      name: "get_usage", description: "Credits used in the last 3 billing cycles, and a suggestion: upgrade, usage_pack, cheaper_plan or none.",
      input: z.object(account), bind, run: ({ accountId }) => store.getUsage(accountId),
    }),
    read({
      name: "get_invoices", description: "The customer's invoices, with the last day each can be refunded.",
      input: z.object(account), bind, run: ({ accountId }) => store.getInvoices(accountId),
    }),
    read({
      name: "get_eligible_plans", description: "Plans this customer can switch to.",
      input: z.object(account), bind, run: ({ accountId }) => store.eligiblePlans(accountId),
    }),
    read({
      name: "quote_plan_change", description: "Price a switch to another plan. The customer must see the quote and say yes before change_plan.",
      input: z.object({ ...account, planId: z.string(), discountCode: z.string().optional() }), bind,
      visible: ["quoteId", "planName", "monthlyPrice", "proratedCharge", "monthlySavings", "monthlyIncrease", "effectiveDate", "expiresAt"],
      records: (q) => ({ commitments: [{ type: "quote", id: q.quoteId, expiresAt: q.expiresAt,
        values: { monthlyPrice: q.monthlyPrice, proratedCharge: q.proratedCharge } }] }),
      run: ({ accountId, planId, discountCode }) => store.quote(accountId, planId, discountCode),
    }),
    write({
      name: "change_plan", description: "Apply an accepted quote.",
      input: z.object({ ...account, quoteId: z.string() }), bind, confirm: { commitment: "quote", by: "quoteId" },
      outcome: (o) => (o.status === "pending" ? "pending" : "done"), reconcileWith: "get_account",   // a timeout is settled by reading the account
      run: ({ accountId, quoteId }) => store.changePlan(accountId, quoteId),
    }),
    write({
      name: "refund_invoice", description: "Refund an invoice, in full or in part, within the refund window.",
      input: z.object({ ...account, invoiceId: z.string(), amount: z.number().positive().optional() }), bind, reconcileWith: "get_invoices",
      run: ({ accountId, invoiceId, amount }) => store.refund(accountId, invoiceId, amount),
    }),
    write({
      name: "add_usage_pack", description: "Add a one-time pack of extra credits to this billing cycle.",
      input: z.object(account), bind, run: ({ accountId }) => store.addUsagePack(accountId),
    }),
    write({
      name: "open_case", description: "Open a support case when something failed or needs follow-up. Give the customer the case id.",
      input: z.object({ ...account, summary: z.string() }), bind, confirm: false,
      run: ({ accountId, summary }) => store.openCase(accountId, summary),
    }),
    write({
      name: "handoff_to_person", description: "Hand the conversation to a person.",
      input: z.object({ summary: z.string() }), beforeVerification: true, confirm: false,
      run: ({ summary }) => ({ handedOff: true, summary }),
    }),
  ];
}
