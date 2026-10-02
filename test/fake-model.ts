import type { Model, ModelRequest, ModelResponse } from "../src/models/types.js";

/** One scripted model step: a draft reply, or one or more tool calls. */
export type Step = string | { call: string; input?: Record<string, unknown> } | { calls: { call: string; input?: Record<string, unknown> }[] };

/** A model that replays a fixed script and records every request it receives. */
export function scripted(steps: Step[]): Model & { requests: ModelRequest[] } {
  let i = 0, ids = 0;
  const requests: ModelRequest[] = [];
  return {
    id: "fake:scripted",
    requests,
    async generate(req): Promise<ModelResponse> {
      requests.push(structuredClone(req));
      const step = steps[i++];
      if (step === undefined) throw new Error(`fake model: script ran out after ${steps.length} steps`);
      if (typeof step === "string") return { text: step, toolCalls: [], stop: "end" };
      const calls = "calls" in step ? step.calls : [step];
      return { text: "", stop: "tool_calls", toolCalls: calls.map((c) => ({ id: `t_${++ids}`, name: c.call, input: c.input ?? {} })) };
    },
  };
}
