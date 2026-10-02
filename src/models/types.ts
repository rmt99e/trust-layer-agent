// The one interface every model adapter implements. Adapters translate this to and from a provider's HTTP API.

export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; input: unknown }

export type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; raw?: unknown }   // raw: provider blocks, echoed within a turn
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ModelRequest { system: string; messages: ModelMessage[]; tools: ToolSpec[]; maxTokens?: number }

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  stop: "end" | "tool_calls" | "max_tokens" | "refusal";
  usage?: { inputTokens: number; outputTokens: number };
  raw?: unknown;                                // the provider's content, for the adapter to echo back unchanged
}

export interface Model {
  id: string;                                   // "provider:model", recorded in traces and snapshots
  generate(req: ModelRequest): Promise<ModelResponse>;
}

/** A network or provider failure after retries. `test` counts it as an infrastructure error, not a fail. */
export class ModelError extends Error {
  constructor(message: string, public status?: number) { super(message); this.name = "ModelError"; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST JSON with one retry on 429, 5xx or a network error. Other failures throw the provider's message. */
export async function postJson(label: string, url: string, headers: Record<string, string>, body: unknown, retryDelayMs = 1000): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    } catch (e) {
      if (attempt === 0) { await sleep(retryDelayMs); continue; }
      throw new ModelError(`${label}: network error: ${(e as Error).message}`);
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await sleep(Number(res.headers.get("retry-after")) * 1000 || retryDelayMs);
      continue;
    }
    const text = await res.text();
    let message = text;
    try { message = JSON.parse(text).error?.message ?? text; } catch { /* not JSON */ }
    throw new ModelError(`${label} ${res.status}: ${message}`, res.status);
  }
}
