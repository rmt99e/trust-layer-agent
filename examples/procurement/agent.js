import { fileURLToPath } from "node:url";
import { Agent, allow, approve, check } from "trust-layer-agent";
import { createStore } from "./store.js";
import { makeTools } from "./tools.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export const INSTRUCTIONS = `You are the purchasing assistant for a company's internal teams. You help staff find catalog items, price them and place orders within their team's budget.
Reply in plain text, no Markdown. Keep replies short. Say what happened, not what you expect to happen.`;

// An order above the team's approval threshold is parked for a person in purchasing instead of being placed or refused.
// The threshold comes from the identify_requester fact; the total from the quote the requester accepted.
const bigOrders = check("orders_over_threshold_need_approval", (e, ctx) => {
  if (e.kind !== "action" || e.tool.name !== "place_order") return allow();
  const quote = ctx.commitments.find((k) => k.type === "quote" && k.id === e.input.quoteId);
  const limit = Number(ctx.facts.maxOrderAmount ?? 0);
  return quote && Number(quote.values.total) > limit ? approve(`Order of $${quote.values.total} is over the team's $${limit} limit for orders without approval.`) : allow();
});

// What a purchasing reply states that the built-in kinds don't know: counts of items, and order status words. The
// built-in "done" words are account vocabulary (switched, refunded), so "placed" and "ordered" need a kind of their own.
// A status is backed only by a status field some tool returned, at any depth (list_orders nests them), never by the
// word appearing in policy text; a returned "placed" also backs its synonym "ordered". The count kind keeps the default
// rule, so any number a tool returned backs "4 items".
const statuses = (v) => Array.isArray(v) ? v.flatMap(statuses) : v && typeof v === "object"
  ? [...(typeof v.status === "string" ? [v.status.toLowerCase()] : []), ...Object.values(v).flatMap(statuses)] : [];
const kinds = [
  { name: "count", find: /\b(\d+) (?:items?|results?|units?|orders?)\b/i },
  { name: "status", find: /\b(placed|ordered|shipped|delivered|cancelled)\b/i,
    confirms: (src) => statuses(src).flatMap((s) => (s === "placed" ? ["placed", "ordered"] : [s])) },
];

// Everything but the model and tools, so the simulator can reuse it unchanged.
export const agentConfig = {
  instructions: INSTRUCTIONS, knowledge: here("./knowledge"), journeys: here("./journeys"),
  checks: [bigOrders], builtins: { no_unconfirmed_claims: { kinds } },
};

export function makeAgent({ model = "anthropic:claude-sonnet-5-5", store = createStore(), trace } = {}) {
  return new Agent({ ...agentConfig, model, tools: makeTools(store), ...(trace !== undefined && { trace }) });
}
