// Tool declarations over the store. The team id is bound from facts once the requester is identified, the catalog
// search only takes words the requester actually used, and a quote must be shown and accepted before an order.
import { read, write, z } from "trust-layer-agent";

const team = { teamId: z.string() };
const bind = { teamId: "facts.teamId" };

export function makeTools(store) {
  return [
    read({
      name: "identify_requester", description: "Identify who is ordering and for which team, with their employee id and team id.",
      input: z.object({ requesterId: z.string(), teamId: z.string() }), beforeVerification: true, verifies: true,
      visible: ["verified", "name", "teamId", "maxOrderAmount"],
      records: (o) => (o.verified ? { facts: { verified: true, requesterId: o.requesterId, teamId: o.teamId, maxOrderAmount: o.maxOrderAmount } } : {}),
      run: ({ requesterId, teamId }) => store.identify(requesterId, teamId),
    }),
    read({
      name: "search_catalog", description: "Search the catalog. Use the requester's own words for the query.",
      input: z.object({ query: z.string() }), fromUser: ["query"],          // the model can't search for things the requester never mentioned
      run: ({ query }) => store.search(query),
    }),
    read({
      name: "get_budget", description: "The team's remaining budget this quarter, its approval threshold and open orders.",
      input: z.object(team), bind, run: ({ teamId }) => store.budget(teamId),
    }),
    read({
      name: "quote_order", description: "Price an order of one catalog item. The requester must see the quote and say yes before place_order.",
      input: z.object({ ...team, itemId: z.string(), quantity: z.number().int().positive() }), bind,
      visible: ["quoteId", "itemName", "quantity", "unitPrice", "total", "etaDate", "expiresAt"],
      records: (q) => ({ commitments: [{ type: "quote", id: q.quoteId, expiresAt: q.expiresAt, values: { total: q.total, unitPrice: q.unitPrice, quantity: q.quantity } }] }),
      run: ({ teamId, itemId, quantity }) => store.quote(teamId, itemId, quantity),
    }),
    write({
      name: "place_order", description: "Place an order from an accepted quote.",
      input: z.object({ ...team, quoteId: z.string() }), bind, confirm: { commitment: "quote", by: "quoteId" },
      reconcileWith: "list_orders",                                           // a timeout is settled by listing the team's orders
      run: ({ teamId, quoteId }) => store.placeOrder(teamId, quoteId),
    }),
    read({
      name: "list_orders", description: "The team's orders so far.",
      input: z.object(team), bind, run: ({ teamId }) => store.orders(teamId),
    }),
    write({
      name: "open_ticket", description: "Open a purchasing ticket when something failed or needs a person. Give the requester the ticket id.",
      input: z.object({ ...team, summary: z.string() }), bind, confirm: false,
      run: ({ teamId, summary }) => store.openTicket(teamId, summary),
    }),
    write({
      name: "handoff_to_person", description: "Hand the conversation to a person in purchasing.",
      input: z.object({ summary: z.string() }), beforeVerification: true, confirm: false,
      run: ({ summary }) => ({ handedOff: true, summary }),
    }),
  ];
}
