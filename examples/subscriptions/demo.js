// A fixed customer script through respond(), printed with the teaching view.
// node --env-file=.env examples/subscriptions/demo.js            (normal)
// FAIL_CHANGE_PLAN=1 node --env-file=.env examples/subscriptions/demo.js   (the change fails)
import { makeAgent } from "./agent.js";

const SCRIPT = [
  "Hi, I'm Sam Ortiz. My account is acc_300 and my PIN is 9902.",
  "I think I'm paying too much. Is there a cheaper plan that fits my usage?",
  "Can you just switch me?",
  "Before you change anything, what exactly would it cost me?",
  "yes",
  "Great, thanks. Is everything done?",
];

const show = { write(l) {
  if (l.type === "tool") console.log(`   · ${l.tool}${l.reconcile ? " (auto re-check)" : ""} → ${l.ok ? "ok" : `failed (${l.error?.code}: ${l.error?.message})`}`);
  if (l.type === "check" && l.event === "action") console.log(`   ✗ blocked ${l.tool}  [${l.check}]  ${l.result.block}`);
  if (l.type === "check" && l.event === "reply" && l.result.block)
    console.log(`   ✗ draft not sent  [${l.check}]\n     draft:  ${JSON.stringify(l.draft)}\n     reason: ${l.result.block}`);
} };

console.log(`=== demo${process.env.FAIL_CHANGE_PLAN === "1" ? " (FAIL_CHANGE_PLAN=1)" : ""} ===\n`);
const agent = makeAgent({ trace: show });
let session = null;
for (const message of SCRIPT) {
  console.log(`you   > ${message}`);
  const r = await agent.respond(session, message);
  session = r.session;
  console.log(`agent > ${r.reply}\n`);
  if (r.handoff) { console.log(`[handed off: ${r.handoff.summary} (${r.handoff.reason})]`); break; }
}
