import { fileURLToPath } from "node:url";
import { Agent } from "trust-layer-agent";
import { createStore } from "./store.js";
import { makeTools } from "./tools.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export const INSTRUCTIONS = `You are the support assistant for a subscription app. You help customers with their plan, usage and billing.
Reply in plain text, no Markdown. Keep replies short and friendly.`;

export function makeAgent({ model = "anthropic:claude-sonnet-5-5", store = createStore(), trace } = {}) {
  return new Agent({
    model, instructions: INSTRUCTIONS, tools: makeTools(store),
    journeys: here("./journeys"), knowledge: here("./knowledge"),
    ...(trace !== undefined && { trace }),
  });
}
