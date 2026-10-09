// A scripted requester through respond(), then the two things a chat can't show: a person approving a parked
// order, and the app's own purchase-order email going through review() before it is sent.
//   node --env-file=.env examples/procurement/demo.js
import { makeAgent } from "./agent.js";
import { createStore, renderPurchaseOrder, SEED } from "./store.js";

const SCRIPT = [
  "Hi, I'm Dana Ruiz, emp_101 on team ops_1.",
  "We need 10 standing desks for the new floor. What would that cost?",
  "yes",
];

const show = { write(l) {
  if (l.type === "tool") console.log(`   · ${l.tool}${l.reconcile ? " (auto re-check)" : ""} → ${l.ok ? "ok" : `failed (${l.error?.code}: ${l.error?.message})`}`);
  if (l.type === "check" && l.event === "action") console.log(`   ${"approve" in l.result ? "⏸ parked " : "✗ blocked "}${l.tool}  [${l.check}]  ${l.result.block ?? l.result.approve}`);
  if (l.type === "check" && l.event === "reply" && l.result.block)
    console.log(`   ✗ draft not sent  [${l.check}]\n     draft:  ${JSON.stringify(l.draft)}\n     reason: ${l.result.block}`);
  if (l.type === "approval") console.log(`   ✓ ${l.decision} ${l.tool} → ${l.ok ? "ok" : `failed (${l.error?.code})`}`);
  if (l.type === "review") console.log(`   review → ${"block" in l.result ? `blocked: ${l.result.block}` : "ok"}`);
} };

console.log("=== procurement demo ===\n");
const store = createStore(), agent = makeAgent({ store, trace: show });
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
console.log(`[a person in purchasing approves ${pending[0].id}: ${pending[0].reason}]`);
({ session } = await agent.approve(session, pending[0].id));
const r = await agent.respond(session, "Did it go through?");
session = r.session;
console.log(`you   > Did it go through?\nagent > ${r.reply}\n`);

const order = store.db.orders.at(-1);
if (order) {
  console.log("[the app renders the supplier email and reviews it before sending]");
  const good = renderPurchaseOrder(order, SEED.teams[order.teamId]);
  console.log(`   ${JSON.stringify(good.split("\n")[2])}`);
  await agent.review(session, good);
  console.log("[the same template with a wrong total]");
  await agent.review(session, good.replace(`$${order.total}`, `$${order.total + 100}`));
}
