#!/usr/bin/env node
// npx trust-layer-agent test --suite <dir> [--k 4] [--tasks a,b] [--agent-model provider:model] [--max-cost 10]
// npx trust-layer-agent snapshot --suite <dir> --name v1
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listFiles } from "./journeys.js";
import type { Model } from "./models/types.js";
import { runSuite, type Suite, type Trial } from "./sim/simulator.js";
import { loadTasks } from "./sim/task.js";
import { toolSpec } from "./tools.js";

export interface TaskSummary { trials: string; passK: boolean; pass1: number; friction: number; cost: number; infra: number }
export interface Run { config: Record<string, string>; summary: Record<string, TaskSummary>; overall: number; cost: number }

/** Per task: trial marks (P/F/I=infra/-=stopped), pass^k over scored trials, pass^1, friction per trial, cost. */
export function summarize(trials: Trial[]): Record<string, TaskSummary> {
  const out: Record<string, TaskSummary> = {};
  for (const t of trials) {
    const s = (out[t.task] ??= { trials: "", passK: false, pass1: 0, friction: 0, cost: 0, infra: 0 });
    s.trials += { pass: "P", fail: "F", infra: "I", stopped: "-" }[t.status];
    s.friction += t.friction ?? 0;
    s.cost += t.cost;
  }
  for (const s of Object.values(out)) {
    const scored = s.trials.replace(/[I-]/g, "");
    s.infra = s.trials.split("I").length - 1;
    s.passK = scored.length > 0 && !scored.includes("F");
    s.pass1 = scored.length ? (scored.split("P").length - 1) / scored.length : 0;
    s.friction /= s.trials.length;
  }
  return out;
}
export const overall = (s: Record<string, TaskSummary>) => { const v = Object.values(s); return v.length ? v.filter((x) => x.passK).length / v.length : 0; };

const hash = (x: unknown) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex").slice(0, 12);
const read = (p?: string | string[], ext?: RegExp) => (p ? listFiles(p, ext).map((f) => readFileSync(f, "utf8")) : []);

/** Everything that can change a score, fingerprinted. */
export function configOf(suite: Suite, suiteFile: string): Record<string, string> {
  const a = suite.agent, id = (m: string | Model) => (typeof m === "string" ? m : m.id);
  return {
    agentModel: id(suite.agentModel), customerModel: id(suite.customerModel),
    instructions: hash(a.instructions), journeys: hash(read(a.journeys)), knowledge: hash(read(a.knowledge, /\.(md|txt)$/)),
    tools: hash(suite.tools.map((t) => ({ ...toolSpec(t), kind: t.kind, bind: t.bind, confirm: t.confirm, visible: t.visible, verifies: t.verifies, before: t.beforeVerification }))),
    checks: hash({ builtins: a.builtins ?? {}, custom: (a.checks ?? []).map((c) => c.name) }),
    suite: hash(readFileSync(suiteFile, "utf8")),
    library: hash(read(fileURLToPath(new URL(".", import.meta.url)), /\.js$/)),   // this package's own code: checks, agent loop
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** Lines describing what changed since a snapshot: config warnings, flipped tasks, friction and cost. */
export function compare(prev: Run & { name: string }, cur: Run): string[] {
  const out = Object.keys(cur.config).filter((k) => prev.config[k] !== cur.config[k]).map((k) => `⚠️  config differs from snapshot "${prev.name}": ${k}`);
  for (const [task, s] of Object.entries(cur.summary)) {
    const p = prev.summary[task];
    if (!p) { out.push(`  + ${task}: new task`); continue; }
    if (p.passK !== s.passK) out.push(`  ${s.passK ? "↑ fail→pass" : "↓ pass→fail"}  ${task}`);
    if (Math.abs(p.friction - s.friction) >= 0.25) out.push(`  ${task}: friction ${p.friction.toFixed(2)} → ${s.friction.toFixed(2)} per trial`);
  }
  out.push(`  overall pass^k ${pct(prev.overall)} → ${pct(cur.overall)}; cost $${prev.cost.toFixed(2)} → $${cur.cost.toFixed(2)}`);
  return out;
}

const newest = (dir: string) => existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).pop() : undefined;
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));

export async function main([cmd, ...args]: string[]) {
  const flag = (n: string, d?: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
  try { process.loadEnvFile(); } catch { /* no .env: keys come from the environment */ }
  if (cmd !== "test" && cmd !== "snapshot") return console.log("usage: trust-layer-agent test|snapshot --suite <dir> [--k 4] [--tasks a,b] [--agent-model m] [--max-cost 10] [--name v1]");
  const suiteFile = join(resolve(flag("suite", ".")!), "suite.js");
  const suite: Suite = (await import(pathToFileURL(suiteFile).href)).default;
  if (flag("agent-model")) suite.agentModel = flag("agent-model")!;

  if (cmd === "snapshot") {
    const name = flag("name"), last = newest("results");
    if (!name || !last) throw new Error(name ? "no results yet: run `test` first" : "--name is required");
    const r = json(last), config = configOf(suite, suiteFile);
    if (hash(r.config) !== hash(config)) throw new Error("the configuration changed since the last test run; run `test` again before snapshotting");
    mkdirSync("snapshots", { recursive: true });
    writeFileSync(`snapshots/${name}.json`, JSON.stringify({ name, createdAt: new Date().toISOString(), k: r.k, config,
      tasks: Object.keys(r.summary), summary: r.summary, overall: r.overall, cost: r.cost, results: last }, null, 2) + "\n");
    return console.log(`snapshots/${name}.json: pass^${r.k} ${pct(r.overall)} over ${Object.keys(r.summary).length} tasks`);
  }

  const k = Number(flag("k", "4")), maxCost = Number(flag("max-cost", "10")), only = flag("tasks")?.split(",");
  const n = loadTasks(suite.tasks).filter((t) => !only || only.includes(t.id)).length, prev = newest("results");
  const perTrial = prev ? json(prev).cost / json(prev).trials.length : 0.08;
  console.log(`Estimated cost: ~$${(n * k * perTrial).toFixed(2)} (${n} tasks × ${k} trials × ~$${perTrial.toFixed(3)}); stops at $${maxCost}.`);
  const run = await runSuite(suite, { k, tasks: only, maxCost,
    onTrial: (t) => console.log(`  ${t.task} #${t.trial}: ${t.status}  $${t.cost.toFixed(3)}  friction ${t.friction}${t.error ? `  (${t.error})` : ""}`) });
  const summary = summarize(run.trials), cur: Run = { config: configOf(suite, suiteFile), summary, overall: overall(summary), cost: run.cost };
  console.log(`\n${"task".padEnd(28)}trials  pass^${k}  pass^1  friction  cost    infra`);
  for (const [task, s] of Object.entries(summary))
    console.log(`${task.padEnd(28)}${s.trials.padEnd(8)}${(s.passK ? "pass" : "FAIL").padEnd(8)}${pct(s.pass1).padEnd(8)}${s.friction.toFixed(2).padEnd(10)}$${s.cost.toFixed(2).padEnd(7)}${s.infra}`);
  console.log(`\npass^${k}: ${pct(cur.overall)} of ${n} tasks · cost $${run.cost.toFixed(2)}${run.stopped ? " · STOPPED at cost limit" : ""}`);
  mkdirSync("results", { recursive: true });
  const file = `results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ ...cur, k, createdAt: new Date().toISOString(), trials: run.trials }) + "\n");
  const snap = newest("snapshots");
  if (snap) console.log(`\nvs ${snap}:\n${compare(json(snap), cur).join("\n")}`);
  console.log(`results: ${file}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
