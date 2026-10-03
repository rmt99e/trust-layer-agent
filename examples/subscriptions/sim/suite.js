// The simulation suite for the subscriptions example. Stand-ins call the same store functions as
// the real tools, over a fresh seeded store per trial; every tool declaration comes from tools.js.
import { fileURLToPath } from "node:url";
import { agentConfig } from "../agent.js";
import { createStore, SEED } from "../store.js";
import { makeTools } from "../tools.js";

export default {
  agent: agentConfig,
  tools: makeTools(createStore()),
  seed: SEED,
  createStore,
  now: "2026-10-03T12:00:00Z",                       // the store's business date
  tasks: fileURLToPath(new URL("./tasks", import.meta.url)),
  agentModel: "anthropic:claude-sonnet-5-5",
  customerModel: "anthropic:claude-sonnet-5-5",
  prices: {                                          // USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing
    "anthropic:claude-sonnet-5-5": { input: 2, output: 10 },
    "anthropic:claude-haiku-4-5-20251001": { input: 1, output: 5 },
  },

  standIns: {
    verify_customer: ({ accountId, pin }, _ctx, s) => s.verify(accountId, pin),
    get_account: ({ accountId }, _ctx, s) => s.getAccount(accountId),
    get_usage: ({ accountId }, _ctx, s) => s.getUsage(accountId),
    get_invoices: ({ accountId }, _ctx, s) => s.getInvoices(accountId),
    get_eligible_plans: ({ accountId }, _ctx, s) => s.eligiblePlans(accountId),
    quote_plan_change: ({ accountId, planId, discountCode }, _ctx, s) => s.quote(accountId, planId, discountCode),
    change_plan: ({ accountId, quoteId }, _ctx, s) => s.changePlan(accountId, quoteId),
    refund_invoice: ({ accountId, invoiceId, amount }, _ctx, s) => s.refund(accountId, invoiceId, amount),
    add_usage_pack: ({ accountId }, _ctx, s) => s.addUsagePack(accountId),
    open_case: ({ accountId, summary }, _ctx, s) => s.openCase(accountId, summary),
    handoff_to_person: ({ summary }) => ({ handedOff: true, summary }),
  },

  // What the grader compares: each account's plan, invoice statuses, usage packs and open cases.
  // Generated ids, quotes and free-text summaries are left out on purpose.
  state: (s) => Object.fromEntries(Object.values(s.db.customers).map((c) => [c.id, {
    plan: c.plan.id, invoices: c.invoices.map((i) => `${i.id}:${i.status}`),
    usagePacks: c.usagePacks.length, cases: (c.cases ?? []).length,
  }])),
};
