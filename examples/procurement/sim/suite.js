// The simulation suite for the procurement example. Stand-ins call the same store functions as the real
// tools, over a fresh seeded store per trial; every tool declaration comes from tools.js.
import { fileURLToPath } from "node:url";
import { agentConfig } from "../agent.js";
import { createStore, SEED } from "../store.js";
import { makeTools } from "../tools.js";

export default {
  agent: agentConfig,
  tools: makeTools(createStore()),
  seed: SEED,
  createStore,
  now: "2026-10-03T12:00:00Z",
  tasks: fileURLToPath(new URL("./tasks", import.meta.url)),
  agentModel: "anthropic:claude-sonnet-5-5",
  userModel: "anthropic:claude-sonnet-5-5",
  prices: {
    "anthropic:claude-sonnet-5-5": { input: 2, output: 10 },
    "anthropic:claude-haiku-4-5-20251001": { input: 1, output: 5 },
  },

  standIns: {
    identify_requester: ({ requesterId, teamId }, _ctx, s) => s.identify(requesterId, teamId),
    search_catalog: ({ query }, _ctx, s) => s.search(query),
    get_budget: ({ teamId }, _ctx, s) => s.budget(teamId),
    quote_order: ({ teamId, itemId, quantity }, _ctx, s) => s.quote(teamId, itemId, quantity),
    place_order: ({ teamId, quoteId }, _ctx, s) => s.placeOrder(teamId, quoteId),
    list_orders: ({ teamId }, _ctx, s) => s.orders(teamId),
    open_ticket: ({ teamId, summary }, _ctx, s) => s.openTicket(teamId, summary),
    handoff_to_person: ({ summary }) => ({ handedOff: true, summary }),
  },

  // What the grader compares: each team's remaining budget and its orders (item, quantity, status), plus ticket counts.
  state: (s) => Object.fromEntries(Object.values(s.db.teams).map((t) => [t.id, {
    budgetBalance: t.budgetBalance,
    orders: s.db.orders.filter((o) => o.teamId === t.id).map((o) => `${o.itemId}×${o.quantity}:${o.status}`),
    tickets: (s.db.tickets ?? []).filter((k) => k.teamId === t.id).length,
  }])),
};
