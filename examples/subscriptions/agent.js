import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "trust-layer-agent";
import { createStore } from "./store.js";
import { makeTools } from "./tools.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export const INSTRUCTIONS = `You are the support assistant for a subscription app. You help customers with their plan, usage and billing.
Reply in plain text, no Markdown. Keep replies short and friendly.`;

// Comparison runs only. TRUST_LAYER_CHECKS=off keeps every prompt (instructions, journey guidance, knowledge) but
// turns off all built-in checks and strips the journeys' guardrails, so the rules exist only as prompt text.
// Tool declarations don't change, so bind injection and field visibility (tool-level) stay on.
const checksOff = process.env.TRUST_LAYER_CHECKS === "off";
function guidanceOnly(dir) {
  const out = mkdtempSync(join(tmpdir(), "tla-guidance-"));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".yaml")))   // guardrails is the last key in each file
    writeFileSync(join(out, f), readFileSync(join(dir, f), "utf8").replace(/^guardrails:[\s\S]*$/m, ""));
  return out;
}

// Everything but the model and tools, so the simulator can reuse it unchanged.
export const agentConfig = {
  instructions: INSTRUCTIONS, knowledge: here("./knowledge"),
  journeys: checksOff ? guidanceOnly(here("./journeys")) : here("./journeys"),
  ...(checksOff && { builtins: { verified_first: false, yes_after_quote: false, no_unconfirmed_claims: false, handoff_after_failures: false } }),
};

/** @param {{ model?: string | import("trust-layer-agent").Model, store?: ReturnType<typeof createStore>, trace?: import("trust-layer-agent").TraceSink | false }} [opts] */
export function makeAgent({ model = "anthropic:claude-sonnet-5-5", store = createStore(), trace } = {}) {
  return new Agent({ ...agentConfig, model, tools: makeTools(store), ...(trace !== undefined && { trace }) });
}
