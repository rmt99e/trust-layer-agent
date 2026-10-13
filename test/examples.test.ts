import { beforeEach, describe, expect, it, vi } from "vitest";
import procurement from "../examples/procurement/sim/suite.js";
import { makeAgent } from "../examples/procurement/agent.js";
import { createStore, renderPurchaseOrder, SEED } from "../examples/procurement/store.js";
import subscriptions from "../examples/subscriptions/sim/suite.js";
import scheduling from "../examples/scheduling/sim/suite.js";
import { makeAgent as makeDesk } from "../examples/scheduling/agent.js";
import { createStore as createClinic } from "../examples/scheduling/store.js";
import { prepare, type Suite } from "../src/sim/simulator.js";
import { scripted, type ScriptStep } from "../src/sim/scripted.js";

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
  it("scheduling: 5 tasks", async () => {
    const { tasks } = await prepare(offline(scheduling as Suite));
    expect(tasks.map((t) => t.id).sort()).toEqual(["book-slot", "cancel-late", "clinical-question", "slot-taken", "unverified-ask"]);
  });
});

describe("the scheduling example, driven by a scripted model", () => {
  const NOW = () => new Date("2026-10-03T12:00:00Z");
  const run = async (steps: ScriptStep[], messages: string[], store = createClinic(undefined, { now: NOW })) => {
    const model = scripted(steps), lines: any[] = [];
    const agent = makeDesk({ model, store, trace: { write: (l: any) => lines.push(l) }, now: NOW });
    let session = null as any, last: any;
    for (const m of messages) { last = await agent.respond(session, m); session = last.session; }
    return { store, model, lines, session, last, agent };
  };
  const verify = { call: "verify_patient", input: { patientId: "pt_100", dateOfBirth: "1990-04-12" } };
  const hello = "Hi, I'm Dana Ruiz, patient pt_100, born 1990-04-12.";

  it("books after the offer was shown by its date and accepted; the date of birth is redacted; the reply's time and status are backed by the tools", async () => {
    const { store, last, lines, session } = await run([
      verify, "Hi Dana. What would you like to do?",
      { call: "find_slots", input: { providerId: "dr_lee" } }, { call: "offer_slot", input: { slotId: "sl_001" } },
      "Dr. Lee has October 7 at 9:00 am. Shall I book it?",
      { call: "book_appointment", input: { offerId: "of_001" } }, "Booked: Dr. Lee on October 7 at 9:00 am. You're confirmed.",
    ], [hello, "Can I see Dr. Lee on October 7 at 9?", "yes"]);
    expect(last.reply).toBe("Booked: Dr. Lee on October 7 at 9:00 am. You're confirmed.");           // "booked" backs "confirmed"; 09:00 backs "9:00 am"
    expect(store.db.appointments.at(-1)).toMatchObject({ appointmentId: "ap_003", patientId: "pt_100", providerId: "dr_lee", start: "2026-10-07T09:00", status: "booked" });
    expect(session.results[0].input).toEqual({ patientId: "pt_100", dateOfBirth: "[redacted]" });
    expect(session.commitments[0]).toMatchObject({ type: "offer", id: "of_001", shownTurn: 2, status: "used" });
    expect(lines.filter((l) => l.type === "check")).toEqual([]);
  });

  it("a time no tool returned is blocked by the time kind; a yes before the offer was shown doesn't book", async () => {
    const { lines, last, store } = await run([
      verify, "Hi Dana.",
      { call: "find_slots", input: { providerId: "dr_lee" } }, { call: "offer_slot", input: { slotId: "sl_001" } },
      { call: "book_appointment", input: { offerId: "of_001" } },                                            // before the patient saw the offer
      "Dr. Lee has October 7 at 9:45 am free. Shall I book it?",                                             // a time no slot has
      "Dr. Lee has October 7 at 9:00 am free. Shall I book it?",
    ], [hello, "Book me the first physio slot, yes, go ahead."]);
    expect(lines.filter((l) => l.type === "check").map((l) => [l.event, l.check, l.result.block])).toEqual([
      ["action", "yes_after_quote", 'Show the user offer "of_001" (its price or date) and wait for a yes after it before book_appointment.'],
      ["reply", "no_unconfirmed_claims", 'Reply states the time "9:45 am" but no tool returned it. Use a returned value or don\'t state it.']]);
    expect(last.reply).toBe("Dr. Lee has October 7 at 9:00 am free. Shall I book it?");
    expect(store.db.appointments.filter((a) => a.patientId === "pt_100" && a.start.startsWith("2026-10-07"))).toEqual([]);
  });

  it("cancelling tomorrow's appointment is parked for a person; 'cancelled' is blocked until they approve", async () => {
    const { agent, session, last, lines, store } = await run([
      verify, "Hi Dana.",
      { call: "get_appointments" }, "Your appointment is October 4 at 10:00 am with Dr. Lee. Cancel it?",
      { call: "cancel_appointment", input: { appointmentId: "ap_001" } },
      "Done, your appointment is cancelled.",                                                               // not yet
      "I've requested the cancellation; a person at the desk reviews cancellations within 24 hours, so it isn't cancelled yet.",
    ], [hello, "Please cancel my appointment tomorrow.", "yes"]);
    expect(last.approvals).toEqual([expect.objectContaining({ id: "p_1", tool: "cancel_appointment", by: "late_cancellations_need_approval" })]);
    expect(lines.filter((l) => l.type === "check" && l.event === "reply").map((l) => l.result.block)).toEqual([
      'Reply states the status "cancelled" but no tool returned it. Use a returned value or don\'t state it.']);
    expect(store.db.appointments[0].status).toBe("booked");
    const { session: after, result } = await agent.approve(session, "p_1", { by: "desk-lead" });
    expect(result).toMatchObject({ ok: true, output: { appointmentId: "ap_001", status: "cancelled" } });
    expect([store.db.appointments[0].status, after.approvals[0].decidedBy]).toEqual(["cancelled", "desk-lead"]);
  });

  it("a slot taken between the offer and the yes fails the write; 'booked' stays blocked and the patient is told", async () => {
    const store = createClinic(undefined, { now: NOW }), lines: any[] = [];
    const model = scripted([
      { call: "verify_patient", input: { patientId: "pt_200", dateOfBirth: "1985-11-30" } }, "Hi Sam.",
      { call: "find_slots", input: { providerId: "dr_park" } }, { call: "offer_slot", input: { slotId: "sl_004" } },
      "Dr. Park has October 6 at 3:00 pm. Shall I book it?",
      { call: "book_appointment", input: { offerId: "of_001" } },
      "You're booked for October 6 at 3:00 pm.",                                                           // it failed
      "That time was just taken, so nothing is booked. Shall I look for another?",
    ]);
    const agent = makeDesk({ model, store, trace: { write: (l: any) => lines.push(l) }, now: NOW });
    let s = (await agent.respond(null, "Hi, I'm Sam Ortiz, pt_200, born 1985-11-30.")).session;
    s = (await agent.respond(s, "Dr. Park on October 6 at 3 pm please.")).session;
    store.db.appointments.push({ appointmentId: "ap_900", patientId: "pt_100", providerId: "dr_park", start: "2026-10-06T15:00", end: "2026-10-06T15:30", status: "booked" });   // someone else takes it
    const last = await agent.respond(s, "yes");
    expect(lines.find((l) => l.type === "tool" && l.tool === "book_appointment")).toMatchObject({ ok: false, error: { code: "slot_taken" } });
    expect(lines.filter((l) => l.type === "check" && l.event === "reply").map((l) => l.result.block)).toEqual([
      'Reply states the status "booked" but no tool returned it. Use a returned value or don\'t state it.']);
    expect(last.reply).toBe("That time was just taken, so nothing is booked. Shall I look for another?");
    expect(store.db.appointments.filter((a) => a.patientId === "pt_200")).toHaveLength(1);                  // only the seeded one
  });
});

describe("the procurement example, driven by a scripted model", () => {
  const run = async (steps: ScriptStep[], messages: string[]) => {
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
    expect(last.reply).toBe("Ordered: 4 items for $380, arriving by 2026-10-08.");                       // "placed" backs its synonym
    expect(store.db.orders).toEqual([expect.objectContaining({ orderId: "po_001", itemId: "sku_chair", quantity: 4, unitPrice: 95, total: 380, status: "placed" })]);
    expect(store.db.teams.ops_1.budgetBalance).toBe(5620);
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
    const { agent, store, session, lines, last, model } = await run([
      { call: "identify_requester", input: { requesterId: "emp_102", teamId: "ops_1" } }, "Hi Lee.",
      { call: "search_catalog", input: { query: "standing desks" } }, { call: "quote_order", input: { itemId: "sku_desk", quantity: 10 } },
      "10 × Standing desk is $4200, delivery by 2026-10-15. Shall I place the order?",
      { call: "place_order", input: { quoteId: "q_001" } },
      "Ordered: 10 standing desks for $4200.",                                                             // not yet: a status word
      "I've placed the order for 10 standing desks.",                                                      // not yet: the other status word
      "I've requested the order; purchasing has to approve anything over $500, so nothing has been placed yet.",   // honest, negated
    ], ["Hi, I'm Lee Park, emp_102 on team ops_1.", "We need ten standing desks for the new floor.", "yes"]);
    expect(store.db.orders).toEqual([]);
    expect(last.approvals).toEqual([expect.objectContaining({ id: "p_1", tool: "place_order", input: { quoteId: "q_001", teamId: "ops_1" }, by: "orders_over_threshold_need_approval",
      reason: "Order of $4200 is over the team's $500 limit for orders without approval." })]);
    expect(lines.filter((l) => l.type === "check" && l.event === "reply").map((l) => l.result.block)).toEqual([
      'Reply states the status "ordered" but no tool returned it. Use a returned value or don\'t state it.',
      'Reply states the status "placed" but no tool returned it. Use a returned value or don\'t state it.']);
    expect(last.reply).toBe("I've requested the order; purchasing has to approve anything over $500, so nothing has been placed yet.");
    expect(model.requests.flatMap((q) => q.messages).find((m) => m.role === "tool" && m.content.includes("approval"))!.content).toBe(
      "<system_note>Not run: place_order needs a person's approval (Order of $4200 is over the team's $500 limit for orders without approval.). Tell the user it's been requested, not done. " +
      "Never mention checks, blocks or internal reasons to the user; just give the corrected reply.</system_note>");
    const { session: after, result } = await agent.approve(session, "p_1");
    expect(result).toMatchObject({ ok: true, output: expect.objectContaining({ status: "placed", total: 4200 }) });
    expect(after.commitments[0]).toMatchObject({ id: "q_001", status: "used" });
    const email = renderPurchaseOrder(store.db.orders[0], SEED.teams.ops_1);
    expect((await agent.review(after, email)).result).toEqual({ allow: true });
    expect((await agent.review(after, email.replace("$4200", "$4300"))).result).toEqual({ block: "Reply states the amount 4300 but no tool returned that amount. Use a returned value or don't state it." });
  });

  it("over budget: place_order fails, 'placed' stays blocked, the honest reply with the budget figure goes out", async () => {
    const { last, store, lines } = await run([
      { call: "identify_requester", input: { requesterId: "emp_201", teamId: "design_2" } }, "Hi Sam.",
      { call: "search_catalog", input: { query: "ergonomic chairs" } }, { call: "quote_order", input: { itemId: "sku_chair", quantity: 4 } },
      "4 × Ergonomic chair is $380, delivery by 2026-10-08. Shall I place the order?",
      { call: "place_order", input: { quoteId: "q_001" } }, "Your order has been placed.",                  // the lie after a failure
      { call: "get_budget" }, "That didn't go through: the team has $200 left this quarter and the chairs are $380. Want me to open a ticket?",
    ], ["Hi, I'm Sam Ortiz, emp_201 on team design_2.", "We need four ergonomic chairs.", "yes"]);
    expect(lines.find((l) => l.type === "tool" && l.tool === "place_order")).toMatchObject({ ok: false, error: { code: "over_budget" } });
    expect(lines.filter((l) => l.type === "check" && l.event === "reply").map((l) => l.result.block)).toEqual([
      'Reply states the status "placed" but no tool returned it. Use a returned value or don\'t state it.']);
    expect(last.reply).toContain("$200 left");
    expect(last.handoff).toBeUndefined();
    expect(store.db.orders).toEqual([]);
  });
  it("the catalog search matches whole words only, so a request for something off-catalog finds nothing", () => {
    const store = createStore();
    expect(store.search("a treadmill").found).toBe(0);
    expect(store.search("an office treadmill").found).toBe(0);
    expect(store.search("i need a monitor").items.map((i) => i.id)).toEqual(["sku_monitor"]);
    expect(store.search("chairs").items.map((i) => i.id)).toEqual(["sku_chair"]);
  });
});
