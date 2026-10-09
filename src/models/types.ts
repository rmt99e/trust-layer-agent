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
  requestId?: string;                           // the provider's id for this request, so a trace line can be matched to its logs
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

/** Shared by both adapters: how long one request may take, and how long one retry may wait. */
export interface HttpOptions { retryDelayMs?: number; timeoutMs?: number }
const DEFAULT_TIMEOUT_MS = 60_000, MAX_RETRY_WAIT_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST JSON with one retry on 429, 5xx, a timeout or a network error. Other failures throw the provider's message. Returns the body and the provider's request id header, if any. */
export async function postJson(label: string, url: string, headers: Record<string, string>, body: unknown, http: HttpOptions = {}): Promise<{ body: any; requestId?: string }> {
  const retryDelayMs = http.retryDelayMs ?? 1000, timeoutMs = http.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (attempt === 0) { await sleep(retryDelayMs); continue; }
      throw new ModelError(`${label}: ${(e as Error).name === "TimeoutError" ? `no response within ${timeoutMs} ms` : `network error: ${(e as Error).message}`}`);
    }
    if (res.ok) return { body: await res.json(), requestId: res.headers.get("request-id") ?? res.headers.get("x-request-id") ?? undefined };
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await sleep(Math.min(Number(res.headers.get("retry-after")) * 1000 || retryDelayMs, MAX_RETRY_WAIT_MS));
      continue;
    }
    const text = await res.text();
    let message = text;
    try { message = JSON.parse(text).error?.message ?? text; } catch { /* not JSON */ }
    throw new ModelError(`${label} ${res.status}: ${message}`, res.status);
  }
}
