import { fileURLToPath } from "node:url";
import { Agent, allow, approve, check } from "trust-layer-agent";
import { createStore } from "./store.js";
import { makeTools } from "./tools.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export const INSTRUCTIONS = `You are the appointment desk of a small clinic. You help patients book, move and cancel appointments.
Reply in plain text, no Markdown. Keep replies short. Give dates and times exactly as the tools return them, in the clinic's local time.
You give no clinical advice of any kind.`;

// Cancelling inside the 24-hour window is parked for a person at the desk instead of being done or refused. The
// appointment's start comes from the get_appointments result the model saw, never from the model's own input.
const lateCancellations = (hoursUntil) => check("late_cancellations_need_approval", (e, ctx) => {
  if (e.kind !== "action" || e.tool.name !== "cancel_appointment") return allow();
  const listed = ctx.results.filter((r) => r.ok && r.tool === "get_appointments").flatMap((r) => r.output?.appointments ?? []);
  const a = listed.find((x) => x.appointmentId === e.input.appointmentId);
  return a && hoursUntil(a.start, ctx.now) < 24 ? approve(`Cancelling less than 24 hours before the appointment needs a person at the desk.`) : allow();
});

// What an appointment reply states that the built-in kinds don't know: clock times, and booking status words. A time
// is backed by any ISO time a tool returned, in the ways people write it (09:00 → "9:00 am", "9 am", "09:00"); a status
// only by a status field some tool returned, with a returned "booked" also backing "confirmed".
const strings = (v) => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
const statuses = (v) => Array.isArray(v) ? v.flatMap(statuses) : v && typeof v === "object"
  ? [...(typeof v.status === "string" ? [v.status.toLowerCase()] : []), ...Object.values(v).flatMap(statuses)] : [];
const spellings = (hh, mm) => {
  const h = Number(hh), h12 = h % 12 || 12, ampm = h < 12 ? "am" : "pm";
  return [`${hh}:${mm}`, `${h}:${mm}`, `${h12}:${mm} ${ampm}`, `${h12}:${mm}${ampm}`, ...(mm === "00" ? [`${h12} ${ampm}`, `${h12}${ampm}`] : [])];
};
export const kinds = [
  { name: "time", find: /\b(\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2})\b/i,
    confirms: (src) => strings(src).flatMap((s) => [...s.matchAll(/T(\d{2}):(\d{2})/g)].flatMap((m) => spellings(m[1], m[2]))) },
  { name: "status", find: /\b(booked|confirmed|cancelled|canceled|rescheduled)\b/i,
    confirms: (src) => statuses(src).flatMap((s) => (s === "booked" ? ["booked", "confirmed"] : s === "cancelled" ? ["cancelled", "canceled"] : [s])) },
];

// Everything but the model and tools, so the simulator can reuse it unchanged. Clinic times are local wall-clock
// values written without a zone; they are compared with the agent's clock as if both were UTC.
export const agentConfig = {
  instructions: INSTRUCTIONS, knowledge: here("./knowledge"), journeys: here("./journeys"),
  checks: [lateCancellations((start, now) => (Date.parse(start + "Z") - now.getTime()) / 3_600_000)], builtins: { no_unconfirmed_claims: { kinds } },
};

/** @param {{ model?: string | import("trust-layer-agent").Model, store?: ReturnType<typeof createStore>, trace?: import("trust-layer-agent").TraceSink | false, now?: () => Date }} [opts] */
export function makeAgent({ model = "anthropic:claude-sonnet-5-5", store = createStore(), trace, now } = {}) {
  return new Agent({ ...agentConfig, model, tools: makeTools(store), ...(trace !== undefined && { trace }), ...(now && { now }) });
}
