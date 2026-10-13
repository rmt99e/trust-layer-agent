// A fictional scheduling desk: people book time with a host. Appointments, meetings and service visits all have
// this shape. Plain JavaScript, no framework. Times are local wall-clock values written as ISO without a zone
// ("2026-10-07T09:00"); the agent says them as given. Tools (tools.js) call these functions; simulations call them
// over a fresh seeded copy.
import { ToolError } from "trust-layer-agent";

export const HOSTS = {
  host_alex: { id: "host_alex", name: "Alex Kim", offers: "onboarding sessions" },
  host_jordan: { id: "host_jordan", name: "Jordan Lee", offers: "account reviews" },
};

export const SEED = {
  today: "2026-10-03",
  people: {
    usr_100: { id: "usr_100", name: "Dana Ruiz", passcode: "4417" },
    usr_200: { id: "usr_200", name: "Sam Ortiz", passcode: "9902" },
  },
  slots: [
    { slotId: "sl_001", hostId: "host_alex", start: "2026-10-07T09:00", end: "2026-10-07T09:30" },
    { slotId: "sl_002", hostId: "host_alex", start: "2026-10-07T09:30", end: "2026-10-07T10:00" },
    { slotId: "sl_003", hostId: "host_alex", start: "2026-10-08T11:00", end: "2026-10-08T11:30" },
    { slotId: "sl_004", hostId: "host_jordan", start: "2026-10-06T15:00", end: "2026-10-06T15:30" },
    { slotId: "sl_005", hostId: "host_jordan", start: "2026-10-09T10:30", end: "2026-10-09T11:00" },
  ],
  bookings: [
    // Tomorrow: cancelling it is inside the 24-hour window, so a person at the desk decides.
    { bookingId: "bk_001", personId: "usr_100", hostId: "host_alex", start: "2026-10-04T10:00", end: "2026-10-04T10:30", status: "booked" },
    { bookingId: "bk_002", personId: "usr_200", hostId: "host_jordan", start: "2026-10-10T14:00", end: "2026-10-10T14:30", status: "booked" },
  ],
};

const withHost = ({ hostId, ...rest }) => ({ ...rest, hostId, hostName: HOSTS[hostId].name, offers: HOSTS[hostId].offers });

export function createStore(seed = SEED, { now = () => new Date() } = {}) {
  const db = structuredClone(seed);
  const counters = { bk: db.bookings.length };                                   // new ids continue after the seeded ones
  const id = (prefix) => `${prefix}_${String((counters[prefix] = (counters[prefix] ?? 0) + 1)).padStart(3, "0")}`;
  const offers = new Map();
  const person = (personId) => {
    const p = db.people[personId];
    if (!p) throw new ToolError("not_found", "No one with that id.");
    return p;
  };
  const free = (slot) => !db.bookings.some((b) => b.status === "booked" && b.hostId === slot.hostId && b.start === slot.start);

  return {
    db,
    verify(personId, passcode) {
      const p = db.people[personId];
      return p && p.passcode === passcode ? { verified: true, personId, name: p.name } : { verified: false, personId };
    },
    bookings(personId) {
      person(personId);
      return { personId, bookings: db.bookings.filter((b) => b.personId === personId && b.status === "booked").map(({ status, ...b }) => withHost(b)) };   // all booked; no status word to echo
    },
    slots(hostId, from) {
      if (hostId && !HOSTS[hostId]) throw new ToolError("not_found", "No host with that id.");
      const slots = db.slots.filter((s) => (!hostId || s.hostId === hostId) && (!from || s.start >= from) && free(s)).map(withHost);
      return { found: slots.length, slots };
    },
    offer(slotId) {
      const slot = db.slots.find((s) => s.slotId === slotId);
      if (!slot || !free(slot)) throw new ToolError("not_found", "That slot isn't available. Call find_slots again.");
      const o = { offerId: id("of"), ...withHost(slot), expiresAt: new Date(now().getTime() + 15 * 60_000).toISOString() };
      offers.set(o.offerId, o);
      return o;
    },
    book(personId, offerId) {
      person(personId);
      const o = offers.get(offerId);
      if (!o) throw new ToolError("not_found", "No such offer. Offer a slot first.");
      const slot = db.slots.find((s) => s.slotId === o.slotId);
      if (!slot || !free(slot)) throw new ToolError("slot_taken", "That time was taken a moment ago. Offer another slot.");
      const b = { bookingId: id("bk"), personId, hostId: o.hostId, start: o.start, end: o.end, status: "booked" };
      db.bookings.push(b);
      return withHost(b);
    },
    cancel(personId, bookingId, reason) {
      person(personId);
      const b = db.bookings.find((x) => x.bookingId === bookingId && x.personId === personId);
      if (!b || b.status !== "booked") throw new ToolError("not_found", "No booking with that id for this person.");
      b.status = "cancelled";
      b.cancelReason = reason;
      return { bookingId, status: "cancelled", start: b.start };
    },
  };
}
