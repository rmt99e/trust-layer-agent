import type { Model } from "./types.js";

/** Turn a "provider:model" string into an adapter. Adapters arrive in a later piece. */
export function resolveModel(model: string | Model): Model {
  if (typeof model !== "string") return model;
  const [provider] = model.split(":");
  throw new Error(`model "${model}": the ${provider} adapter isn't built yet; pass an object implementing Model`);
}
