// A model that replays a fixed script, for tests that need no network and no key. Exported as `trust-layer-agent/testing`.
import type { Model, ModelRequest, ModelResponse } from "../models/types.js";

/** One scripted model step: a draft reply, or one or more tool calls. */
export type ScriptStep = string | { call: string; input?: Record<string, unknown> } | { calls: { call: string; input?: Record<string, unknown> }[] };

/** A model that replays a fixed script and records every request it receives. */
export function scripted(steps: ScriptStep[], opts: { id?: string; usage?: ModelResponse["usage"]; fail?: Error } = {}): Model & { requests: ModelRequest[] } {
  let i = 0, ids = 0;
  const requests: ModelRequest[] = [];
  return {
    id: opts.id ?? "scripted",
    requests,
    async generate(req): Promise<ModelResponse> {
      requests.push(structuredClone(req));                      // a copy for assertions; ModelRequest is JSON, so this can't throw
      if (opts.fail) throw opts.fail;
      const step = steps[i++];
      if (step === undefined) throw new Error(`scripted model: script ran out after ${steps.length} steps`);
      if (typeof step === "string") return { text: step, toolCalls: [], stop: "end", usage: opts.usage };
      const calls = "calls" in step ? step.calls : [step];
      return { text: "", stop: "tool_calls", usage: opts.usage, toolCalls: calls.map((c) => ({ id: `t_${++ids}`, name: c.call, input: c.input ?? {} })) };
    },
  };
}
