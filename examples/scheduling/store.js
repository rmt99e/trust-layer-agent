// A fictional clinic's appointment book. Plain JavaScript, no framework. Times are the clinic's local time, written as
// ISO without a zone ("2026-10-07T09:00"); the agent says them as given. Tools (tools.js) call these functions;
// simulations call them over a fresh seeded copy.
import { ToolError } from "trust-layer-agent";

export const PROVIDERS = {
  dr_lee: { id: "dr_lee", name: "Dr. Lee", service: "physiotherapy" },
  dr_park: { id: "dr_park", name: "Dr. Park", service: "general practice" },
};

export const SEED = {
  today: "2026-10-03",
  patients: {
    pt_100: { id: "pt_100", name: "Dana Ruiz", dateOfBirth: "1990-04-12" },
    pt_200: { id: "pt_200", name: "Sam Ortiz", dateOfBirth: "1985-11-30" },
  },
  slots: [
    { slotId: "sl_001", providerId: "dr_lee", start: "2026-10-07T09:00", end: "2026-10-07T09:30" },
    { slotId: "sl_002", providerId: "dr_lee", start: "2026-10-07T09:30", end: "2026-10-07T10:00" },
    { slotId: "sl_003", providerId: "dr_lee", start: "2026-10-08T11:00", end: "2026-10-08T11:30" },
    { slotId: "sl_004", providerId: "dr_park", start: "2026-10-06T15:00", end: "2026-10-06T15:30" },
    { slotId: "sl_005", providerId: "dr_park", start: "2026-10-09T10:30", end: "2026-10-09T11:00" },
  ],
  appointments: [
    // Tomorrow: cancelling it is inside the 24-hour window, so a person at the desk decides.
    { appointmentId: "ap_001", patientId: "pt_100", providerId: "dr_lee", start: "2026-10-04T10:00", end: "2026-10-04T10:30", status: "booked" },
    { appointmentId: "ap_002", patientId: "pt_200", providerId: "dr_park", start: "2026-10-10T14:00", end: "2026-10-10T14:30", status: "booked" },
  ],
};

const withProvider = ({ providerId, ...rest }) => ({ ...rest, providerId, providerName: PROVIDERS[providerId].name, service: PROVIDERS[providerId].service });

export function createStore(seed = SEED, { now = () => new Date() } = {}) {
  const db = structuredClone(seed);
  const counters = { ap: db.appointments.length };                                   // new ids continue after the seeded ones
  const id = (prefix) => `${prefix}_${String((counters[prefix] = (counters[prefix] ?? 0) + 1)).padStart(3, "0")}`;
  const offers = new Map();
  const patient = (patientId) => {
    const p = db.patients[patientId];
    if (!p) throw new ToolError("not_found", "No patient with that id.");
    return p;
  };
  const free = (slot) => !db.appointments.some((a) => a.status === "booked" && a.providerId === slot.providerId && a.start === slot.start);

  return {
    db,
    verify(patientId, dateOfBirth) {
      const p = db.patients[patientId];
      return p && p.dateOfBirth === dateOfBirth ? { verified: true, patientId, name: p.name } : { verified: false, patientId };
    },
    appointments(patientId) {
      patient(patientId);
      return { patientId, appointments: db.appointments.filter((a) => a.patientId === patientId && a.status === "booked").map(withProvider) };
    },
    slots(providerId, from) {
      if (providerId && !PROVIDERS[providerId]) throw new ToolError("not_found", "No provider with that id.");
      const slots = db.slots.filter((s) => (!providerId || s.providerId === providerId) && (!from || s.start >= from) && free(s)).map(withProvider);
      return { found: slots.length, slots };
    },
    offer(slotId) {
      const slot = db.slots.find((s) => s.slotId === slotId);
      if (!slot || !free(slot)) throw new ToolError("not_found", "That slot isn't available. Call find_slots again.");
      const o = { offerId: id("of"), ...withProvider(slot), expiresAt: new Date(now().getTime() + 15 * 60_000).toISOString() };
      offers.set(o.offerId, o);
      return o;
    },
    book(patientId, offerId) {
      patient(patientId);
      const o = offers.get(offerId);
      if (!o) throw new ToolError("not_found", "No such offer. Offer a slot first.");
      const slot = db.slots.find((s) => s.slotId === o.slotId);
      if (!slot || !free(slot)) throw new ToolError("slot_taken", "That time was taken a moment ago. Offer another slot.");
      const a = { appointmentId: id("ap"), patientId, providerId: o.providerId, start: o.start, end: o.end, status: "booked" };
      db.appointments.push(a);
      return withProvider(a);
    },
    cancel(patientId, appointmentId, reason) {
      patient(patientId);
      const a = db.appointments.find((x) => x.appointmentId === appointmentId && x.patientId === patientId);
      if (!a || a.status !== "booked") throw new ToolError("not_found", "No booked appointment with that id for this patient.");
      a.status = "cancelled";
      a.cancelReason = reason;
      return { appointmentId, status: "cancelled", start: a.start };
    },
  };
}
