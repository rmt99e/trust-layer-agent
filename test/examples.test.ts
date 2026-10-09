import { beforeEach, describe, expect, it, vi } from "vitest";
import procurement from "../examples/procurement/sim/suite.js";
import { makeAgent } from "../examples/procurement/agent.js";
import { createStore, renderPurchaseOrder, SEED } from "../examples/procurement/store.js";
import subscriptions from "../examples/subscriptions/sim/suite.js";
import { prepare, type Suite } from "../src/sim/simulator.js";
import { scripted, type Step } from "./fake-model.js";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });

// prepare() is what `test` runs before any model call: stand-ins must match the tools, every task must be valid and
// name real tools, and each expected write must apply to the seed. Both shipped suites have to pass it.
const offline = (suite: Suite): Suite => ({ ...suite, agentModel: scripted([], { id: "fake:agent" }), userModel: scripted([], { id: "fake:user" }),
  prices: { "fake:agent": { input: 1, output: 1 }, "fake:user": { input: 1, output: 1 } } });

describe("the shipped suites are valid before any model call", () => {
  it("subscriptions: 22 tasks", async () => expect((await prepare(offline(subscriptions as Suite))).tasks).toHaveLength(22));
  it("procurement: 4 tasks", async () => {
    const { tasks } = await prepare(offline(procurement as Suite));
    expect(tasks.map((t) => t.id).sort()).toEqual(["made-up-item", "order-needs-approval", "order-within-threshold", "over-budget"]);
  });
});

describe("the procurement example, driven by a scripted model", () => {
  const run = async (steps: Step[], messages: string[]) => {
    const store = createStore(), model = scripted(steps), lines: any[] = [];
    const agent = makeAgent({ model, store, trace: { write: (l: any) => lines.push(l) } });
    let session = null as any, last: any;
    for (const m of messages) { last = await agent.respond(session, m); session = last.session; }
    return { store, model, lines, session, last, agent };
  };
  const identify = { call: "identify_requester", input: { requesterId: "emp_101", teamId: "ops_1" } };

  it("within the threshold: identify, search with the requester's words, quote, yes, order; the reply states what the tools returned", async () => {
    const { store, last, lines } = await run([
      identify, "Hi Dana. What does the team need?",
      { call: "search_catalog", input: { query: "ergonomic chairs" } }, { call: "quote_order", input: { itemId: "sku_chair", quantity: 4 } },
      "4 × Ergonomic chair is $380 in total, delivery by 2026-10-08. Shall I place the order?",
      { call: "place_order", input: { quoteId: "q_001" } }, "Ordered: 4 items for $380, arriving by 2026-10-08.",
    ], ["Hi, I'm Dana Ruiz, emp_101 on team ops_1.", "We need four ergonomic chairs.", "yes"]);
    expect(last.reply).toBe("Ordered: 4 items for $380, arriving by 2026-10-08.");
    expect(store.db.orders).toEqual([expect.objectContaining({ orderId: "po_002", itemId: "sku_chair", quantity: 4, total: 380, status: "ordered" })]);
    expect(store.db.teams.ops_1.budgetRemaining).toBe(5620);
    expect(lines.filter((l) => l.type === "check")).toEqual([]);
  });

  it("a search for words the requester never said is blocked, and the model is told", async () => {
    const { model, lines, last } = await run([
      identify, "Hi Dana. What does the team need?",
      { call: "search_catalog", input: { query: "office seating" } }, { call: "search_catalog", input: { query: "chairs" } }, "I found 1 item: the Ergonomic chair at $95.",
    ], ["Hi, I'm Dana Ruiz, emp_101 on team ops_1.", "We need some chairs."]);
    expect(lines.find((l) => l.type === "check" && l.event === "action")).toMatchObject({ tool: "search_catalog", check: "no_invented_inputs",
      result: { block: 'The user never said "office seating" (query in search_catalog). Use only values the user gave, or ask them.' } });
    const blocked = model.requests.at(-1)!.messages.find((m) => m.role === "tool" && m.isError)!;
    expect(blocked.content).toContain('Not run. Blocked: The user never said "office seating"');
    expect(last.reply).toBe("I found 1 item: the Ergonomic chair at $95.");
  });

  it("over the threshold: the order is parked, 'ordered' is blocked until a person approves, then the supplier email is reviewed", async () => {
    const { agent, store, session, lines, last } = await run([
      { call: "identify_requester", input: { requesterId: "emp_102", teamId: "ops_1" } }, "Hi Lee.",
      { call: "search_catalog", input: { query: "standing desks" } }, { call: "quote_order", input: { itemId: "sku_desk", quantity: 10 } },
      "10 × Standing desk is $4200, delivery by 2026-10-15. Shall I place the order?",
      { call: "place_order", input: { quoteId: "q_001" } },
      "Ordered: 10 standing desks for $4200.",                                                             // not yet
      "I've requested the order; purchasing has to approve anything over $500, so nothing has been placed yet.",
    ], ["Hi, I'm Lee Park, emp_102 on team ops_1.", "We need ten standing desks for the new floor.", "yes"]);
    expect(store.db.orders).toEqual([]);
    expect(last.approvals).toEqual([expect.objectContaining({ id: "p_1", tool: "place_order", input: { quoteId: "q_001", teamId: "ops_1" }, by: "orders_over_threshold_need_approval",
      reason: "Order of $4200 is over the team's $500 limit for orders without approval." })]);
    expect(lines.filter((l) => l.type === "check" && l.event === "reply").map((l) => l.result.block)).toEqual([
      'Reply states the status "ordered" but no tool returned it. Use a returned value or don\'t state it.']);
    const { session: after, result } = await agent.approve(session, "p_1");
    expect(result).toMatchObject({ ok: true, output: expect.objectContaining({ status: "ordered", total: 4200 }) });
    expect(after.commitments[0]).toMatchObject({ id: "q_001", status: "used" });
    const email = renderPurchaseOrder(store.db.orders[0], SEED.teams.ops_1);
    expect((await agent.review(after, email)).result).toEqual({ allow: true });
    expect((await agent.review(after, email.replace("$4200", "$4300"))).result).toEqual({ block: "Reply states the amount 4300 but no tool returned that amount. Use a returned value or don't state it." });
  });

  it("over budget: place_order fails with over_budget and the journey hands off", async () => {
    const { last, store } = await run([
      { call: "identify_requester", input: { requesterId: "emp_201", teamId: "design_2" } }, "Hi Sam.",
      { call: "search_catalog", input: { query: "ergonomic chairs" } }, { call: "quote_order", input: { itemId: "sku_chair", quantity: 4 } },
      "4 × Ergonomic chair is $380, delivery by 2026-10-08. Shall I place the order?",
      { call: "place_order", input: { quoteId: "q_001" } }, "Sorry, the team is over budget for that.",   // the draft is never sent: the journey hands off first
    ], ["Hi, I'm Sam Ortiz, emp_201 on team design_2.", "We need four ergonomic chairs.", "yes"]);
    expect(last.handoff).toEqual({ summary: "The team is over budget for this order.", reason: "order:handoff_when" });
    expect(last.reply).toBe("I'm passing you to a person who can help. They'll pick this up from here.");
    expect(store.db.orders).toEqual([]);
  });
});
