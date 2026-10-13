// Tool declarations over the booking store. The person's id is bound from facts once they are verified, the passcode
// used to verify is a secret the session never keeps, an offered slot is a commitment the person must see and accept
// before it is booked, and a cancellation needs a plain yes.
import { read, write, z } from "trust-layer-agent";

const who = { personId: z.string() };
const bind = { personId: "facts.personId" };

export function makeTools(store) {
  return [
    read({
      name: "verify_person", description: "Verify who is booking, with their id and passcode.",
      input: z.object({ personId: z.string(), passcode: z.string() }), secret: ["passcode"], beforeVerification: true, verifies: true,
      visible: ["verified", "name"],
      records: (o) => (o.verified ? { facts: { verified: true, personId: o.personId } } : {}),
      run: ({ personId, passcode }) => store.verify(personId, passcode),
    }),
    read({
      name: "get_bookings", description: "The person's upcoming bookings.",
      input: z.object(who), bind, run: ({ personId }) => store.bookings(personId),
    }),
    read({
      name: "find_slots", description: "Free slots, optionally for one host (host_alex: onboarding sessions, host_jordan: account reviews) and from a date (YYYY-MM-DD).",
      input: z.object({ hostId: z.string().optional(), from: z.string().optional() }),
      run: ({ hostId, from }) => store.slots(hostId, from),
    }),
    read({
      name: "offer_slot", description: "Offer one slot. The offer holds for 15 minutes; the person must see the date and time and say yes before book_slot.",
      input: z.object({ slotId: z.string() }),
      records: (o) => ({ commitments: [{ type: "offer", id: o.offerId, expiresAt: o.expiresAt, values: { start: o.start, end: o.end, hostName: o.hostName } }] }),
      run: ({ slotId }) => store.offer(slotId),
    }),
    write({
      name: "book_slot", description: "Book the offered slot for the person.",
      input: z.object({ ...who, offerId: z.string() }), bind, confirm: { commitment: "offer", by: "offerId" },
      reconcileWith: "get_bookings",                                           // a timeout is settled by reading the bookings back
      run: ({ personId, offerId }) => store.book(personId, offerId),
    }),
    write({
      name: "cancel_booking", description: "Cancel one of the person's bookings. Tell them which one and wait for a yes first.",
      input: z.object({ ...who, bookingId: z.string(), reason: z.string().optional() }), bind,
      run: ({ personId, bookingId, reason }) => store.cancel(personId, bookingId, reason),
    }),
    write({
      name: "handoff_to_person", description: "Hand the conversation to a person at the desk.",
      input: z.object({ summary: z.string() }), beforeVerification: true, confirm: false,
      run: ({ summary }) => ({ handedOff: true, summary }),
    }),
  ];
}
