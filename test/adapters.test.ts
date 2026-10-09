import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropic, ModelError, openaiCompatible, type ModelRequest } from "../src/index.js";
import { resolveModel } from "../src/models/resolve.js";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mockFetch = (...responses: Response[]) => {
  const fn = vi.fn(async () => responses.shift() ?? reply(500, { error: { message: "no more responses" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
};
const sent = (fn: ReturnType<typeof mockFetch>, i = 0) => {
  const [url, init] = fn.mock.calls[i] as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
};
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const req: ModelRequest = {
  system: "Be helpful.",
  tools: [{ name: "get_account", description: "Account.", inputSchema: { type: "object", properties: {} } }],
  messages: [
    { role: "user", content: "<user_message>hi</user_message>" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "get_account", input: {} }] },
    { role: "tool", toolCallId: "t1", name: "get_account", content: "<tool_result>{\"plan\":\"Basic\"}</tool_result>" },
    { role: "tool", toolCallId: "t2", name: "get_x", content: "<system_note>Not run.</system_note>", isError: true },
  ],
};

describe("anthropic adapter", () => {
  it("sends the Messages API shape with no sampling params, and merges tool results into one user turn", async () => {
    const fn = mockFetch(reply(200, { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } }));
    await anthropic({ model: "m-1", apiKey: "sk-test" }).generate(req);
    const { url, headers, body } = sent(fn);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers).toMatchObject({ "x-api-key": "sk-test", "anthropic-version": "2023-06-01" });
    expect(body).toEqual({ model: "m-1", max_tokens: 16000, system: "Be helpful.",
      tools: [{ name: "get_account", description: "Account.", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "<user_message>hi</user_message>" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_account", input: {} }] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "t1", content: "<tool_result>{\"plan\":\"Basic\"}</tool_result>" },
          { type: "tool_result", tool_use_id: "t2", content: "<system_note>Not run.</system_note>", is_error: true }] },
      ] });
    expect(body).not.toHaveProperty("temperature");
  });

  it("parses tool calls, stop reasons and usage, and keeps raw blocks to echo back", async () => {
    const blocks = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "tu_1", name: "get_account", input: { a: 1 } }];
    mockFetch(reply(200, { content: blocks, stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 7 } }));
    const res = await anthropic({ model: "m", apiKey: "k" }).generate(req);
    expect(res).toEqual({ text: "", toolCalls: [{ id: "tu_1", name: "get_account", input: { a: 1 } }], stop: "tool_calls",
      usage: { inputTokens: 5, outputTokens: 7 }, raw: blocks });
    const fn = mockFetch(reply(200, { content: [], stop_reason: "end_turn" }));
    await anthropic({ model: "m", apiKey: "k" }).generate({ ...req, messages: [{ role: "assistant", content: "", raw: blocks, toolCalls: [] }] });
    expect(sent(fn).body.messages).toEqual([{ role: "assistant", content: blocks }]);   // thinking block echoed unchanged
  });

  it("retries once on 429 and 5xx, then throws the provider's message as ModelError", async () => {
    const ok = reply(200, { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
    const fn = mockFetch(reply(429, { error: { message: "rate limited" } }), ok);
    expect((await anthropic({ model: "m", apiKey: "k", retryDelayMs: 0 }).generate(req)).text).toBe("hi");
    expect(fn).toHaveBeenCalledTimes(2);
    mockFetch(reply(529, { error: { message: "overloaded" } }), reply(529, { error: { message: "overloaded" } }));
    await expect(anthropic({ model: "m", apiKey: "k", retryDelayMs: 0 }).generate(req)).rejects.toSatisfy((e) => e instanceof ModelError && e.status === 529 && e.message === "anthropic 529: overloaded");
    const fn400 = mockFetch(reply(400, { error: { message: "max_tokens: too large" } }));
    await expect(anthropic({ model: "m", apiKey: "k", retryDelayMs: 0 }).generate(req)).rejects.toMatchObject({ status: 400, message: "anthropic 400: max_tokens: too large" });
    expect(fn400).toHaveBeenCalledTimes(1);
  });

  it("maps refusals", async () => {
    mockFetch(reply(200, { content: [], stop_reason: "refusal" }));
    expect((await anthropic({ model: "m", apiKey: "k" }).generate(req)).stop).toBe("refusal");
  });
});

describe("openai-compatible adapter", () => {
  it("sends chat-completions shape with the system prompt first and tool calls as JSON strings", async () => {
    const fn = mockFetch(reply(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    await openaiCompatible({ model: "llama3.2", baseUrl: "http://localhost:11434/v1/" }).generate(req);
    const { url, headers, body } = sent(fn);
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(headers).not.toHaveProperty("authorization");
    expect(body).toEqual({ model: "llama3.2",
      tools: [{ type: "function", function: { name: "get_account", description: "Account.", parameters: { type: "object", properties: {} } } }],
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "<user_message>hi</user_message>" },
        { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "get_account", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "<tool_result>{\"plan\":\"Basic\"}</tool_result>" },
        { role: "tool", tool_call_id: "t2", content: "<system_note>Not run.</system_note>" },
      ] });
  });

  it("parses tool calls (including bad JSON), stop reasons and usage", async () => {
    mockFetch(reply(200, { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "get_account", arguments: "{\"id\":\"acc_1\"}" } },
      { id: "c2", type: "function", function: { name: "get_account", arguments: "{oops" } }] } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 } }));
    const res = await openaiCompatible({ model: "m", apiKey: "k" }).generate(req);
    expect(res).toEqual({ text: "", stop: "tool_calls", usage: { inputTokens: 3, outputTokens: 4 },
      toolCalls: [{ id: "c1", name: "get_account", input: { id: "acc_1" } }, { id: "c2", name: "get_account", input: { _unparseable: "{oops" } }] });
  });

  it("sends a bearer key for hosted servers and maps errors", async () => {
    const fn = mockFetch(reply(401, { error: { message: "Incorrect API key provided" } }));
    await expect(openaiCompatible({ model: "m", apiKey: "sk-x", retryDelayMs: 0 }).generate(req)).rejects.toThrow("openai-compatible 401: Incorrect API key provided");
    expect(sent(fn).headers.authorization).toBe("Bearer sk-x");
    expect(sent(fn).url).toBe("https://api.openai.com/v1/chat/completions");
  });
});

describe("provider:model strings", () => {
  it("resolve to adapters using environment keys", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    expect(resolveModel("anthropic:some-model").id).toBe("anthropic:some-model");
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(resolveModel("openai-compatible:llama3.2:3b").id).toBe("openai-compatible:llama3.2:3b");
  });
  it("name the missing variable and never print a key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => resolveModel("anthropic:m")).toThrow("anthropic: no API key. Set ANTHROPIC_API_KEY or pass apiKey.");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(() => resolveModel("openai-compatible:m")).toThrow(/Set OPENAI_API_KEY/);
    expect(() => resolveModel("gemini:m")).toThrow(/use "anthropic:<model>" or "openai-compatible:<model>"/);
  });
});
