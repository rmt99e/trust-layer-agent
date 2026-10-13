import { anthropic } from "./anthropic.js";
import { openaiCompatible } from "./openai-compatible.js";
import type { Model } from "./types.js";

const PROVIDERS: Record<string, (name: string) => Model> = { anthropic: (name) => anthropic({ model: name }), "openai-compatible": (name) => openaiCompatible({ model: name }) };
const parse = (model: string) => {
  const i = model.indexOf(":"), provider = model.slice(0, i), name = model.slice(i + 1);
  if (i > 0 && provider in PROVIDERS) return { provider, name };
  throw new Error(`model "${model}": use "anthropic:<model>" or "openai-compatible:<model>", or pass an object implementing Model`);
};
/** The id a model resolves to, with the string's shape checked but no adapter built: no key is needed. */
export const modelId = (model: string | Model): string => (typeof model === "string" ? (parse(model), model) : model.id);
/** "anthropic:<model>" or "openai-compatible:<model>" → an adapter; keys come from the environment. */
export function resolveModel(model: string | Model): Model {
  if (typeof model !== "string") return model;
  const { provider, name } = parse(model);
  return PROVIDERS[provider](name);
}
