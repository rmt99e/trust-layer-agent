// Shared helpers for the agent-level test files: an agent over an in-memory trace sink, a logged-in session, raw model responses.
import { Agent, createSession, type Model, type ModelResponse } from "../src/index.js";
import { scripted, type Step } from "./fake-model.js";

export const session = () => createSession({ facts: { verified: true, accountId: "acc_1" } });
/** A model whose steps may also be raw responses, for stop reasons the scripted model can't express. */
export const raw = (steps: (Step | Partial<ModelResponse>)[]): Model & { requests: any[] } => {
  const inner = scripted(steps.filter((s) => typeof s === "string" || "call" in s || "calls" in s) as Step[]);
  let i = 0;
  return { id: "fake:raw", requests: inner.requests, async generate(req) {
    const step = steps[i++];
    if (typeof step === "object" && step && !("call" in step) && !("calls" in step)) { inner.requests.push(structuredClone(req)); return { text: "", toolCalls: [], stop: "end", ...step } as ModelResponse; }
    return inner.generate(req);
  } };
};
/** Every trace line the agents built with `agent()` emit; clear it in beforeEach. */
export const lines: any[] = [];
export const sink = { write: (l: any) => lines.push(l) };
export const agent = (model: Model, tools: any[], extra: Record<string, unknown> = {}) =>
  new Agent({ model, instructions: "You help.", tools, trace: sink, builtins: { verified_first: false }, ...extra });
