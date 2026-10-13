// A scripted requester through respond(): a booking after an offer and a yes, then a cancellation inside the 24-hour
// window that a person at the desk has to approve with agent.approve().
//   node --env-file=.env examples/scheduling/demo.js
import { teachingView } from "trust-layer-agent";
import { makeAgent } from "./agent.js";
import { createStore } from "./store.js";

const NOW = () => new Date("2026-10-03T12:00:00Z");                 // the seed's "today": Dana's existing booking is tomorrow
const SCRIPT = [
  "Hi, I'm Dana Ruiz, usr_100, passcode 4417.",
  "Can I book Alex on October 7 at 9 in the morning?",
  "yes",
  "Also, please cancel my booking tomorrow.",
  "yes",
];

console.log("=== scheduling demo ===\n");
const store = createStore(undefined, { now: NOW }), agent = makeAgent({ store, trace: { write: teachingView }, now: NOW });
let session = null;
for (const message of SCRIPT) {
  console.log(`you   > ${message}`);
  const r = await agent.respond(session, message);
  session = r.session;
  console.log(`agent > ${r.reply}\n`);
  if (r.handoff) { console.log(`[handed off: ${r.handoff.summary} (${r.handoff.reason})]`); process.exit(0); }
}

const pending = session.approvals.filter((a) => a.status === "pending");
if (!pending.length) { console.log("(nothing was parked for approval this run)"); process.exit(0); }
console.log(`[a person at the desk approves ${pending[0].id}: ${pending[0].reason}]`);
({ session } = await agent.approve(session, pending[0].id, { by: "desk-lead" }));
const r = await agent.respond(session, "Is it cancelled now?");
console.log(`you   > Is it cancelled now?\nagent > ${r.reply}\n`);
console.log("bookings now:", store.db.bookings.map((b) => `${b.bookingId} ${b.start} ${b.status}`).join(", "));
