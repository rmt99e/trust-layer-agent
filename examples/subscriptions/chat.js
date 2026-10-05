// Try the agent in your terminal:
//   node --env-file=.env examples/subscriptions/chat.js
// Demo toggles:
//   CHANGE_PLAN_OUTCOME=fail|timeout|pending   how change_plan behaves (FAIL_CHANGE_PLAN=1 still means fail)
//   AGENT_MODEL=sonnet|haiku                   which model plays the agent (default sonnet)
import { makeAgent } from "./agent.js";
import { createStore, SEED } from "./store.js";

const MODELS = { sonnet: "anthropic:claude-sonnet-5-5", haiku: "anthropic:claude-haiku-4-5-20251001" };
// Each outcome reuses the store's failure injection: fail via FAIL_CHANGE_PLAN, the others via seed.outcomes.
const OUTCOMES = { normal: undefined, fail: undefined, timeout: "timeout_applied", pending: "pending" };

const outcome = process.env.CHANGE_PLAN_OUTCOME ?? (process.env.FAIL_CHANGE_PLAN === "1" ? "fail" : "normal");
const modelName = process.env.AGENT_MODEL ?? "sonnet";
if (!(outcome in OUTCOMES)) throw new Error(`CHANGE_PLAN_OUTCOME must be fail, timeout or pending (got "${outcome}")`);
if (!(modelName in MODELS)) throw new Error(`AGENT_MODEL must be sonnet or haiku (got "${modelName}")`);
if (outcome === "fail") process.env.FAIL_CHANGE_PLAN = "1";

const seed = OUTCOMES[outcome] ? { ...structuredClone(SEED), outcomes: { change_plan: OUTCOMES[outcome] } } : SEED;
console.log(`model: ${MODELS[modelName]}  ·  change_plan outcome: ${outcome}\n`);
await makeAgent({ model: MODELS[modelName], store: createStore(seed) }).chat();
