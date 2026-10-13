import { fileURLToPath } from "node:url";
import { Agent, allow, approve, check } from "trust-layer-agent";
import { createStore } from "./store.js";
import { makeTools } from "./tools.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export const INSTRUCTIONS = `You are a scheduling desk. You help people book and cancel time with the hosts on the calendar.
Reply in plain text, no Markdown. Keep replies short. Give dates and times exactly as the tools return them, in local time.
You only schedule. Hand off only when the person asks for someone at the desk or wants something you can't do; a request waiting for the desk's approval is not a reason to hand off.`;

// Cancelling inside the 24-hour window is parked for a person at the desk instead of being done or refused. The
// booking's start comes from the get_bookings result the model saw, never from the model's own input. Times are
// local wall-clock values written without a zone, compared with the agent's clock as if both were UTC.
const WINDOW_HOURS = 24;
const lateCancellations = check("late_cancellations_need_approval", (e, ctx) => {
  if (e.kind !== "action" || e.tool.name !== "cancel_booking") return allow();
  const listed = ctx.results.filter((r) => r.ok && r.tool === "get_bookings").flatMap((r) => r.output?.bookings ?? []);
  const b = listed.find((x) => x.bookingId === e.input.bookingId);
  const hoursUntil = b && (Date.parse(b.start + "Z") - ctx.now.getTime()) / 3_600_000;
  return b && hoursUntil < WINDOW_HOURS ? approve(`Cancellations less than ${WINDOW_HOURS} hours before the booking are approved at the desk, not here.`) : allow();
});

// What a scheduling reply states that the built-in kinds don't know: clock times, and booking status words. A time is
// backed by any ISO time a tool returned, in the ways people write it (09:00 → "9:00 am", "9 am", "09:00"); a status
// only by a status field some tool returned, with a returned "booked" also backing "confirmed". get_bookings returns no status, so a
// past booking can't back "you're booked" after a failed book_slot: only book_slot and cancel_booking results do.
const strings = (v) => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
const statuses = (v) => Array.isArray(v) ? v.flatMap(statuses) : v && typeof v === "object"
  ? [...(typeof v.status === "string" ? [v.status.toLowerCase()] : []), ...Object.values(v).flatMap(statuses)] : [];
const spellings = (hh, mm) => {
  const h = Number(hh), h12 = h % 12 || 12, ampm = h < 12 ? "am" : "pm";
  return [`${hh}:${mm}`, `${h}:${mm}`, `${h12}:${mm} ${ampm}`, `${h12}:${mm}${ampm}`, ...(mm === "00" ? [`${h12} ${ampm}`, `${h12}${ampm}`] : [])];
};
const TIME = /\b(\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2})\b/gi;              // "9:00 am", "9 am", "09:00"; not "9 in the morning" or "noon"
export const kinds = [
  { name: "time", find: TIME,
    confirms: (src) => strings(src).flatMap((s) => [...[...s.matchAll(/T(\d{2}):(\d{2})/g)].flatMap((m) => spellings(m[1], m[2])),   // ISO times from tools
      ...[...s.matchAll(/\b(\d{1,2}):(\d{2})\b/g)].flatMap((m) => spellings(m[1].padStart(2, "0"), m[2]))]) },                        // "08:00" in policy text, in every spelling
  { name: "status", find: /\b(booked|confirmed|cancelled|canceled|rescheduled)\b/i,
    confirms: (src) => statuses(src).flatMap((s) => (s === "booked" ? ["booked", "confirmed"] : s === "cancelled" ? ["cancelled", "canceled"] : [s])) },
];

// Everything but the model and tools, so the simulator can reuse it unchanged.
export const agentConfig = {
  instructions: INSTRUCTIONS, knowledge: here("./knowledge"), journeys: here("./journeys"),
  checks: [lateCancellations], builtins: { no_unconfirmed_claims: { kinds } },
};

/** @param {{ model?: string | import("trust-layer-agent").Model, store?: ReturnType<typeof createStore>, trace?: import("trust-layer-agent").TraceSink | false, now?: () => Date }} [opts] */
export function makeAgent({ model = "anthropic:claude-sonnet-5-5", store = createStore(), trace, now } = {}) {
  return new Agent({ ...agentConfig, model, tools: makeTools(store), ...(trace !== undefined && { trace }), ...(now && { now }) });
}
