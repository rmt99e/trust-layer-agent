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
    ops_1: { id: "ops_1", name: "Operations", budgetBalance: 6000, maxOrderAmount: 500, members: { emp_101: "Dana Ruiz", emp_102: "Lee Park" } },
    // Almost out of budget this quarter.
    design_2: { id: "design_2", name: "Design", budgetBalance: 200, maxOrderAmount: 500, members: { emp_201: "Sam Ortiz" } },
  },
  orders: [],
};

const money = (n) => Math.round(n * 100) / 100;
const STOP_WORDS = new Set(["a", "an", "the", "some", "any", "for", "we", "i", "need", "want", "please", "of", "to", "and", "our", "my", "office", "new"]);
const addDays = (iso, d) => new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10);

export function createStore(seed = SEED, { now = () => new Date() } = {}) {
  const db = structuredClone(seed);
  const counters = {};
  const id = (prefix) => `${prefix}_${String((counters[prefix] = (counters[prefix] ?? 0) + 1)).padStart(3, "0")}`;
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
    search(query) {                                                                       // whole words only: "a treadmill" matches nothing
      const words = query.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w && !STOP_WORDS.has(w));
      const items = CATALOG.filter((c) => words.some((w) => c.tags.includes(w) || c.name.toLowerCase().split(/[^a-z0-9-]+/).includes(w)))
        .map(({ tags, ...c }) => c);
      return { query, found: items.length, items };
    },
    budget(teamId) {
      const t = team(teamId);
      return { teamId, name: t.name, budgetBalance: t.budgetBalance, maxOrderAmount: t.maxOrderAmount, openOrders: db.orders.filter((o) => o.teamId === teamId && o.status === "placed").length };
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
      // Numbers in an error aren't claim sources (only successful results are), so the message names no amounts: the model has get_budget for that.
      if (q.total > t.budgetBalance) throw new ToolError("over_budget", "This order is more than the team has left this quarter. Check get_budget and offer a ticket.");
      t.budgetBalance = money(t.budgetBalance - q.total);
      const order = { orderId: id("po"), teamId, itemId: q.itemId, itemName: q.itemName, quantity: q.quantity, unitPrice: q.unitPrice, total: q.total, status: "placed", etaDate: q.etaDate };
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
  return `Purchase order ${order.orderId} for ${team.name}\n\n${order.quantity} × ${order.itemName} at $${order.unitPrice} each.\n` +
    `Total: $${order.total}. Requested delivery by ${order.etaDate}.\n\nPlease confirm receipt of this order.`;
}
