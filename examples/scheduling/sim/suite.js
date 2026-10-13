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
    verify_patient: ({ patientId, dateOfBirth }, _ctx, s) => s.verify(patientId, dateOfBirth),
    get_appointments: ({ patientId }, _ctx, s) => s.appointments(patientId),
    find_slots: ({ providerId, from }, _ctx, s) => s.slots(providerId, from),
    offer_slot: ({ slotId }, _ctx, s) => s.offer(slotId),
    book_appointment: ({ patientId, offerId }, _ctx, s) => s.book(patientId, offerId),
    cancel_appointment: ({ patientId, appointmentId, reason }, _ctx, s) => s.cancel(patientId, appointmentId, reason),
    handoff_to_person: ({ summary }) => ({ handedOff: true, summary }),
  },

  // What the grader compares: each patient's appointments (provider, start, status), sorted.
  state: (s) => Object.fromEntries(Object.values(s.db.patients).map((p) => [p.id,
    s.db.appointments.filter((a) => a.patientId === p.id).map((a) => `${a.providerId}@${a.start}:${a.status}`).sort()])),
};
