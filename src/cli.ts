#!/usr/bin/env node
// npx trust-layer-agent test --suite <dir> [--k 4] [--tasks a,b] [--agent-model provider:model] [--max-cost 10] [--min-pass 1] [--against v1]
// npx trust-layer-agent snapshot --suite <dir> --name v1
import { claimKinds } from "./builtins.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listFiles } from "./files.js";
import type { Model } from "./models/types.js";
import { runSuite, type Suite, type Trial } from "./sim/simulator.js";
import { loadTasks } from "./sim/task.js";
import { toolSpec, type Tool } from "./tools.js";
import type { ClaimKind } from "./claims.js";

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
  const a = suite.agent;
  return {
    agentModel: modelId(suite.agentModel), userModel: modelId(suite.userModel),
    instructions: hash(a.instructions), journeys: hash(read(a.journeys)), knowledge: hash(read(a.knowledge, /\.(md|txt)$/)),
    tools: hash(suite.tools.map(toolFingerprint)),
    checks: hash({ builtins: a.builtins ?? {}, custom: (a.checks ?? []).map((c) => c.name), kinds: claimKinds(a.builtins).map(kindFingerprint) }),
    suite: hash(readFileSync(suiteFile, "utf8")),
    library: hash(libraryFiles()),                  // this package's own code: checks, agent loop, simulator, adapters
  };
}

const modelId = (m: string | Model) => (typeof m === "string" ? m : m.id);
// Every declaration that changes behavior, with function bodies as source text (JSON would drop them).
const toolFingerprint = (t: Tool) => ({ ...toolSpec(t), kind: t.kind, bind: t.bind, confirm: t.confirm, visible: t.visible, verifies: t.verifies,
  before: t.beforeVerification, outcome: t.outcome?.toString(), reconcileWith: t.reconcileWith, repeatable: t.repeatable, fromUser: t.fromUser });
const kindFingerprint = (k: ClaimKind) => ({ name: k.name, find: String(k.find), confirms: k.confirms?.toString() });

// Every compiled .js file in this package, recursively (sim/, models/ too), in a stable order.
export const libraryFiles = (dir = fileURLToPath(new URL(".", import.meta.url))) => readdirSync(dir, { recursive: true }).map(String)
  .filter((f) => f.endsWith(".js")).sort().map((f) => readFileSync(join(dir, f), "utf8"));

/** Exit 1 when pass^k is below minPass or any task flipped pass→fail since the snapshot; reasons say why. */
export function gate(cur: Run, prev: Run | undefined, minPass: number): { code: 0 | 1; reasons: string[] } {
  const flipped = prev ? Object.keys(cur.summary).filter((t) => prev.summary[t]?.passK && !cur.summary[t].passK) : [];
  const reasons = [...(cur.overall < minPass ? [`pass^k ${pct(cur.overall)} is below --min-pass ${pct(minPass)}`] : []),
    ...(flipped.length ? [`pass→fail since the snapshot: ${flipped.join(", ")}`] : [])];
  return { code: reasons.length ? 1 : 0, reasons };
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

/** Cost per trial: the last run's tokens per trial, priced at the CURRENT models' prices. */
export function estimatePerTrial(trials: Trial[], suite: Suite): number {
  const withTokens = trials.filter((t) => t.tokens?.agent && t.tokens.user);   // results written before the user role are priced by mean cost
  if (!withTokens.length) return trials.length ? trials.reduce((a, t) => a + t.cost, 0) / trials.length : 0.08;
  const price = (role: "agent" | "user", m: string | Model) => {
    const p = suite.prices[modelId(m)] ?? { input: 0, output: 0 };
    return withTokens.reduce((a, t) => a + t.tokens![role].input * p.input + t.tokens![role].output * p.output, 0) / 1e6 / withTokens.length;
  };
  return price("agent", suite.agentModel) + price("user", suite.userModel);
}

const newest = (dir: string) => existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).pop() : undefined;
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));

/** The snapshot to diff against: the one named by --against, or else the newest in the directory. */
export function pickSnapshot(dir: string, name?: string): string | undefined {
  if (!name) return newest(dir);
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`--against ${name}: no snapshot at ${file}`);
  return file;
}

export async function main([cmd, ...args]: string[]) {
  const flag = (n: string, d?: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
  try { process.loadEnvFile(); } catch { /* no .env: keys come from the environment */ }
  if (cmd !== "test" && cmd !== "snapshot") throw new Error("usage: trust-layer-agent test|snapshot --suite <dir> [--k 4] [--tasks a,b] [--agent-model m] [--max-cost 10] [--min-pass 1] [--against v1] [--name v1]");
  const num = (n: string, d: string, max = Infinity) => {
    const raw = flag(n, d), v = Number(raw);
    if (raw === undefined || !Number.isFinite(v) || v < 0 || v > max) throw new Error(`--${n} needs a number${max < Infinity ? ` from 0 to ${max}` : ""} (got ${raw === undefined ? "nothing" : `"${raw}"`})`);
    return v;
  };
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
      tasks: Object.keys(r.summary), summary: r.summary, overall: r.overall, cost: r.cost }, null, 2) + "\n");
    return console.log(`snapshots/${name}.json: pass^${r.k} ${pct(r.overall)} over ${Object.keys(r.summary).length} tasks`);
  }

  const snap = pickSnapshot("snapshots", flag("against"));          // resolve first: a bad name must fail before any model call
  const k = num("k", "4"), maxCost = num("max-cost", "10"), minPass = num("min-pass", "1", 1), only = flag("tasks")?.split(",");
  if (!Number.isInteger(k) || k < 1) throw new Error(`--k needs a whole number of trials, at least 1 (got ${k})`);
  const n = loadTasks(suite.tasks).filter((t) => !only || only.includes(t.id)).length, prev = newest("results");
  const perTrial = estimatePerTrial(prev ? json(prev).trials : [], suite);
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
  if (snap) console.log(`\nvs ${snap}:\n${compare(json(snap), cur).join("\n")}`);
  const g = gate(cur, snap ? json(snap) : undefined, minPass);
  process.exitCode = g.code;
  console.log(g.code ? `\nFAILED the gate (exit 1): ${g.reasons.join("; ")}` : "\nPassed the gate (exit 0).");
  console.log(`results: ${file}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 2; });
