import { postJson, type Model, type ModelMessage, type ModelResponse } from "./types.js";

export interface AnthropicOptions {
  model: string;
  apiKey?: string;                    // default: ANTHROPIC_API_KEY
  baseUrl?: string;
  maxTokens?: number;
  extra?: Record<string, unknown>;    // passed through to the request body, e.g. sampling or effort settings
  retryDelayMs?: number;
}
const STOP: Record<string, ModelResponse["stop"]> = { end_turn: "end", tool_use: "tool_calls", max_tokens: "max_tokens", refusal: "refusal" };

/** Anthropic Messages API over fetch. Sends no sampling parameters unless you pass them in `extra`. */
export function anthropic(o: AnthropicOptions): Model {
  const apiKey = o.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("anthropic: no API key. Set ANTHROPIC_API_KEY or pass apiKey.");
  const url = `${(o.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
  return {
    id: `anthropic:${o.model}`,
    async generate(req) {
      const tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      const body = { model: o.model, max_tokens: req.maxTokens ?? o.maxTokens ?? 16000, system: req.system,
        messages: toAnthropic(req.messages), ...(tools.length && { tools }), ...o.extra };
      const res = await postJson("anthropic", url, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body, o.retryDelayMs);
      const blocks: any[] = res.content ?? [];
      return {
        text: blocks.filter((b) => b.type === "text").map((b) => b.text).join(""),
        toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input })),
        stop: STOP[res.stop_reason] ?? "end",
        usage: res.usage && { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        raw: blocks,
      };
    },
  };
}

/** Internal messages → Anthropic: tool results become user content blocks; same-role neighbours merge. */
export function toAnthropic(messages: ModelMessage[]) {
  const out: { role: "user" | "assistant"; content: any[] }[] = [];
  const push = (role: "user" | "assistant", block: unknown) =>
    out.at(-1)?.role === role ? out.at(-1)!.content.push(block) : out.push({ role, content: [block] });
  for (const m of messages) {
    if (m.role === "user") push("user", { type: "text", text: m.content });
    else if (m.role === "tool") push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError && { is_error: true }) });
    else for (const b of (m.raw as any[]) ?? [...(m.content ? [{ type: "text", text: m.content }] : []),
      ...(m.toolCalls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }))]) push("assistant", b);
  }
  return out;
}
