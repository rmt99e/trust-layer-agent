// Tool declarations over the appointment book. The patient id is bound from facts once the patient is verified, the
// date of birth used to verify is a secret the session never keeps, an offered slot is a commitment the patient
// must see and accept before it is booked, and a cancellation needs a plain yes.
import { read, write, z } from "trust-layer-agent";

const patient = { patientId: z.string() };
const bind = { patientId: "facts.patientId" };

export function makeTools(store) {
  return [
    read({
      name: "verify_patient", description: "Verify the patient with their patient id and date of birth (YYYY-MM-DD).",
      input: z.object({ patientId: z.string(), dateOfBirth: z.string() }), secret: ["dateOfBirth"], beforeVerification: true, verifies: true,
      visible: ["verified", "name"],
      records: (o) => (o.verified ? { facts: { verified: true, patientId: o.patientId } } : {}),
      run: ({ patientId, dateOfBirth }) => store.verify(patientId, dateOfBirth),
    }),
    read({
      name: "get_appointments", description: "The patient's upcoming appointments.",
      input: z.object(patient), bind, run: ({ patientId }) => store.appointments(patientId),
    }),
    read({
      name: "find_slots", description: "Free appointment slots, optionally for one provider (dr_lee: physiotherapy, dr_park: general practice) and from a date (YYYY-MM-DD).",
      input: z.object({ providerId: z.string().optional(), from: z.string().optional() }),
      run: ({ providerId, from }) => store.slots(providerId, from),
    }),
    read({
      name: "offer_slot", description: "Offer one slot to the patient. The offer holds for 15 minutes; the patient must see the date and time and say yes before book_appointment.",
      input: z.object({ slotId: z.string() }),
      records: (o) => ({ commitments: [{ type: "offer", id: o.offerId, expiresAt: o.expiresAt, values: { start: o.start, end: o.end, providerName: o.providerName } }] }),
      run: ({ slotId }) => store.offer(slotId),
    }),
    write({
      name: "book_appointment", description: "Book the offered slot for the patient.",
      input: z.object({ ...patient, offerId: z.string() }), bind, confirm: { commitment: "offer", by: "offerId" },
      reconcileWith: "get_appointments",                                       // a timeout is settled by reading the appointments back
      run: ({ patientId, offerId }) => store.book(patientId, offerId),
    }),
    write({
      name: "cancel_appointment", description: "Cancel one of the patient's appointments. Tell the patient which one and wait for a yes first.",
      input: z.object({ ...patient, appointmentId: z.string(), reason: z.string().optional() }), bind,
      run: ({ patientId, appointmentId, reason }) => store.cancel(patientId, appointmentId, reason),
    }),
    write({
      name: "handoff_to_person", description: "Hand the conversation to a person at the desk.",
      input: z.object({ summary: z.string() }), beforeVerification: true, confirm: false,
      run: ({ summary }) => ({ handedOff: true, summary }),
    }),
  ];
}
