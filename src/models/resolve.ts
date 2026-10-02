import { anthropic } from "./anthropic.js";
import { openaiCompatible } from "./openai-compatible.js";
import type { Model } from "./types.js";

/** "anthropic:<model>" or "openai-compatible:<model>" → an adapter; keys come from the environment. */
export function resolveModel(model: string | Model): Model {
  if (typeof model !== "string") return model;
  const i = model.indexOf(":"), provider = model.slice(0, i), name = model.slice(i + 1);
  if (i > 0 && provider === "anthropic") return anthropic({ model: name });
  if (i > 0 && provider === "openai-compatible") return openaiCompatible({ model: name });
  throw new Error(`model "${model}": use "anthropic:<model>" or "openai-compatible:<model>", or pass an object implementing Model`);
}
