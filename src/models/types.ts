// The one interface every model adapter implements. Adapters translate this to and from a provider's HTTP API.

export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; input: unknown }

export type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ModelRequest { system: string; messages: ModelMessage[]; tools: ToolSpec[]; maxTokens?: number }

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  stop: "end" | "tool_calls" | "max_tokens" | "refusal";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface Model {
  id: string;                                   // "provider:model", recorded in traces and snapshots
  generate(req: ModelRequest): Promise<ModelResponse>;
}

/** A network or provider failure after retries. `test` counts it as an infrastructure error, not a fail. */
export class ModelError extends Error {
  constructor(message: string, public status?: number) { super(message); this.name = "ModelError"; }
}
