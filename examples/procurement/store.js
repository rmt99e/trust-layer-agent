// A fictional company's purchasing data and rules. Plain JavaScript, no framework.
// Tools (tools.js) call these functions; simulations call them over a fresh seeded copy.
import { ToolError } from "trust-layer-agent";

export const CATALOG = [
  { id: "sku_chair", name: "Ergonomic chair", unitPrice: 95, leadDays: 5, tags: ["chair", "chairs", "seating", "ergonomic"] },
  { id: "sku_desk", name: "Standing desk", unitPrice: 420, leadDays: 12, tags: ["desk", "desks", "standing"] },
  { id: "sku_monitor", name: "27-inch monitor", unitPrice: 310, leadDays: 7, tags: ["monitor", "monitors", "screen", "display"] },
  { id: "sku_headset", name: "Wireless headset", unitPrice: 140, leadDays: 3, tags: ["headset", "headsets", "headphones"] },
  { id: "sku_cable", name: "USB-C cable, 2 m", unitPrice: 12, leadDays: 2, tags: ["cable", "cables", "usb", "usb-c", "charger"] },
];

export const SEED = {
  today: "2026-10-03",
  teams: {
    // A small team: orders up to $500 go through on their own; above that a person approves.
    ops_1: { id: "ops_1", name: "Operations", budgetRemaining: 6000, maxOrderAmount: 500, members: { emp_101: "Dana Ruiz", emp_102: "Lee Park" } },
    // Almost out of budget this quarter.
    design_2: { id: "design_2", name: "Design", budgetRemaining: 200, maxOrderAmount: 500, members: { emp_201: "Sam Ortiz" } },
  },
  orders: [],
};

const money = (n) => Math.round(n * 100) / 100;
const addDays = (iso, d) => new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10);

export function createStore(seed = SEED, { now = () => new Date() } = {}) {
  const db = structuredClone(seed);
  let next = 1;
  const id = (prefix) => `${prefix}_${String(next++).padStart(3, "0")}`;
  const quotes = new Map();
  const team = (teamId) => {
    const t = db.teams[teamId];
    if (!t) throw new ToolError("not_found", "No team with that id.");
    return t;
  };

  return {
    db,
    identify(requesterId, teamId) {
      const t = db.teams[teamId], name = t?.members[requesterId];
      return name ? { verified: true, requesterId, teamId, name, maxOrderAmount: t.maxOrderAmount } : { verified: false, requesterId, teamId };
    },
    search(query) {
      const words = query.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
      const items = CATALOG.filter((c) => words.some((w) => c.tags.includes(w) || c.name.toLowerCase().includes(w)))
        .map(({ tags, ...c }) => c);
      return { query, found: items.length, items };
    },
    budget(teamId) {
      const t = team(teamId);
      return { teamId, name: t.name, budgetRemaining: t.budgetRemaining, maxOrderAmount: t.maxOrderAmount, openOrders: db.orders.filter((o) => o.teamId === teamId && o.status === "ordered").length };
    },
    quote(teamId, itemId, quantity) {
      team(teamId);
      const item = CATALOG.find((c) => c.id === itemId);
      if (!item) throw new ToolError("not_found", "No catalog item with that id. Search the catalog first.");
      const q = { quoteId: id("q"), teamId, itemId, itemName: item.name, quantity, unitPrice: item.unitPrice, total: money(item.unitPrice * quantity),
        etaDate: addDays(db.today, item.leadDays), expiresAt: new Date(now().getTime() + 24 * 3600_000).toISOString() };
      quotes.set(q.quoteId, q);
      return q;
    },
    placeOrder(teamId, quoteId) {
      const t = team(teamId), q = quotes.get(quoteId);
      if (!q || q.teamId !== teamId) throw new ToolError("not_found", "No such quote for this team.");
      if (q.total > t.budgetRemaining) throw new ToolError("over_budget", `The team has $${t.budgetRemaining} left this quarter; this order is $${q.total}.`);
      if (db.outcomes?.place_order === "timeout_applied") {                            // demo: the order lands, the response doesn't
        t.budgetRemaining = money(t.budgetRemaining - q.total);
        db.orders.push({ orderId: id("po"), teamId, itemId: q.itemId, quantity: q.quantity, total: q.total, status: "ordered", etaDate: q.etaDate });
        throw new ToolError("timeout", "The purchasing system did not respond.", { outcome: "unknown" });
      }
      t.budgetRemaining = money(t.budgetRemaining - q.total);
      const order = { orderId: id("po"), teamId, itemId: q.itemId, itemName: q.itemName, quantity: q.quantity, total: q.total, status: "ordered", etaDate: q.etaDate };
      db.orders.push(order);
      return order;
    },
    orders(teamId) {
      team(teamId);
      return { teamId, orders: db.orders.filter((o) => o.teamId === teamId) };
    },
    openTicket(teamId, summary) {
      team(teamId);
      const ticket = { ticketId: id("tk"), teamId, summary, status: "open" };
      (db.tickets ??= []).push(ticket);
      return ticket;
    },
  };
}

/** The purchase-order email the app sends to the supplier. App-rendered, so it goes through agent.review() before sending. */
export function renderPurchaseOrder(order, team) {
  return `Purchase order ${order.orderId} for ${team.name}\n\n${order.quantity} × ${order.itemName} at $${order.unitPrice ?? money(order.total / order.quantity)} each.\n` +
    `Total: $${order.total}. Requested delivery by ${order.etaDate}.\n\nPlease confirm receipt of this order.`;
}
