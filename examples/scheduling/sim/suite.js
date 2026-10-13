// The simulation suite for the scheduling example. Stand-ins call the same store functions as the real tools,
// over a fresh seeded store per trial; every tool declaration comes from tools.js.
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
    verify_person: ({ personId, passcode }, _ctx, s) => s.verify(personId, passcode),
    get_bookings: ({ personId }, _ctx, s) => s.bookings(personId),
    find_slots: ({ hostId, from }, _ctx, s) => s.slots(hostId, from),
    offer_slot: ({ slotId }, _ctx, s) => s.offer(slotId),
    book_slot: ({ personId, offerId }, _ctx, s) => s.book(personId, offerId),
    cancel_booking: ({ personId, bookingId, reason }, _ctx, s) => s.cancel(personId, bookingId, reason),
    handoff_to_person: ({ summary }) => ({ handedOff: true, summary }),
  },

  // What the grader compares: each person's bookings (host, start, status), sorted.
  state: (s) => Object.fromEntries(Object.values(s.db.people).map((p) => [p.id,
    s.db.bookings.filter((b) => b.personId === p.id).map((b) => `${b.hostId}@${b.start}:${b.status}`).sort()])),
};
