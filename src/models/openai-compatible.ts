import { postJson, type HttpOptions, type Model, type ModelMessage, type ModelResponse } from "./types.js";

export interface OpenAICompatibleOptions extends HttpOptions {
  model: string;
  baseUrl?: string;                   // default: OPENAI_BASE_URL, then https://api.openai.com/v1; works with local servers
  apiKey?: string;                    // default: OPENAI_API_KEY; not needed for localhost
  maxTokens?: number;
  extra?: Record<string, unknown>;
}
const STOP: Record<string, ModelResponse["stop"]> = { stop: "end", tool_calls: "tool_calls", length: "max_tokens", content_filter: "refusal" };

/** Any server speaking the OpenAI chat-completions format, over fetch. */
export function openaiCompatible(o: OpenAICompatibleOptions): Model {
  const baseUrl = (o.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = o.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey && !/\/\/(localhost|127\.0\.0\.1)[:/]/.test(baseUrl + "/"))
    throw new Error("openai-compatible: no API key. Set OPENAI_API_KEY or pass apiKey (not needed for a local server).");
  return {
    id: `openai-compatible:${o.model}`,
    async generate(req) {
      const tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      const maxTokens = req.maxTokens ?? o.maxTokens;
      const body = { model: o.model, messages: [{ role: "system", content: req.system }, ...toOpenAI(req.messages)],
        ...(tools.length && { tools }), ...(maxTokens && { max_tokens: maxTokens }), ...o.extra };
      const { body: res, requestId } = await postJson("openai-compatible", `${baseUrl}/chat/completions`, apiKey ? { authorization: `Bearer ${apiKey}` } : {}, body, o);
      const choice = res.choices?.[0] ?? {};
      return {
        text: textOf(choice.message?.content),
        toolCalls: (choice.message?.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) })),
        stop: STOP[choice.finish_reason] ?? "end",
        usage: res.usage && { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens },
        requestId: requestId ?? res.id,
      };
    },
  };
}

// Some servers return content as an array of parts; the text is the concatenation of the text parts.
const textOf = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "";
const parseArgs = (a: unknown) => { try { return typeof a === "string" ? JSON.parse(a || "{}") : a ?? {}; } catch { return { _unparseable: a }; } };

export const toOpenAI = (messages: ModelMessage[]) => messages.map((m) =>
  m.role === "tool" ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
  : m.role === "user" ? { role: "user", content: m.content }
  : { role: "assistant", content: m.content || null, ...(m.toolCalls?.length && {
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }) });
