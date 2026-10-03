// Run the subscriptions simulation suite (until the `test` CLI lands):
//   node --env-file=.env examples/subscriptions/sim/run.js [--k 1] [--validate] [task-id …]
import { mkdirSync, writeFileSync } from "node:fs";
import { prepare, runSuite } from "trust-layer-agent/sim";
import suite from "./suite.js";

const args = process.argv.slice(2);
const k = Number(args[args.indexOf("--k") + 1]) || 1;
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--k");
if (args.includes("--validate")) {
  const { tasks } = await prepare(suite, only.length ? only : undefined);
  console.log(`ok: ${tasks.length} tasks validated against the seed (${tasks.map((t) => t.id).join(", ")})`);
  process.exit(0);
}

const mark = (c) => (c.pass ? "pass" : "FAIL");
const run = await runSuite(suite, { k, tasks: only.length ? only : undefined, onTrial: (t) => {
  const g = t.grade;
  console.log(`\n${t.task} #${t.trial}: ${t.status.toUpperCase()}  ended=${t.ended ?? "-"}  turns=${t.turns}  $${t.cost.toFixed(3)}` +
    (g ? `  state=${mark(g.state)} forbidden=${mark(g.forbidden)} handoff=${mark(g.handoff)} claims=${mark(g.claims)}` : `  ${t.error ?? ""}`));
  for (const c of g ? ["state", "forbidden", "handoff", "claims"].filter((n) => !g[n].pass) : []) console.log(`   ${c}: ${g[c].detail}`);
  for (const l of t.events.filter((e) => e.type === "check"))
    console.log(`   ✗ ${l.event === "action" ? `blocked ${l.tool}` : "draft not sent"}  [${l.check}]  ${l.result.block ?? l.result.handoff ?? l.result.rewrite}`);
} });
mkdirSync("results", { recursive: true });
const file = `results/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
writeFileSync(file, run.trials.map((t) => JSON.stringify(t)).join("\n") + "\n");
console.log(`\n${run.trials.filter((t) => t.status === "pass").length}/${run.trials.length} passed, ` +
  `${run.trials.filter((t) => t.status === "infra").length} infra errors, cost $${run.cost.toFixed(2)}${run.stopped ? " (stopped at cost limit)" : ""}. Results: ${file}`);
