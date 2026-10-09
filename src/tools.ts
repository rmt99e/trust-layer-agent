import { z } from "zod";
import { isPersonalName, maskText } from "./privacy.js";
import { currentTurn, type Commitment, type Json, type Session, type ToolResult } from "./session.js";

/** Throw from a tool to send the model a structured error it can act on. */
/** Throw from a tool to send the model a structured error. outcome "unknown": the write may have happened (e.g. a timeout). */
export class ToolError extends Error {
  outcome?: "unknown";
  constructor(public code: string, message: string, opts: { outcome?: "unknown" } = {}) { super(message); this.name = "ToolError"; this.outcome = opts.outcome; }
}

export interface ToolContext { facts: Readonly<Record<string, Json>>; commitments: readonly Commitment[] }
export interface Records {
  facts?: Record<string, Json>;
  commitments?: { type: string; id: string; values: Record<string, Json>; expiresAt?: string }[];
}

export interface ToolDef<I extends Record<string, any> = any, O = any> {
  name: string;
  description: string;
  input: z.ZodObject<any>;
  visible?: string[];
  bind?: Record<string, string>;                         // { accountId: "facts.accountId" }
  fromCustomer?: string[];                               // inputs whose values must come from the customer's own words or a fact
  confirm?: false | { commitment: string; by: string };  // writes only
  beforeVerification?: boolean;
  verifies?: boolean;
  output?: z.ZodType<O>;
  records?: (output: O, input: I) => Records;
  outcome?: (output: O) => "done" | "pending";          // writes: how to read a successful result (default "done")
  reconcileWith?: string;                               // writes: the read tool that settles an unknown outcome
  repeatable?: boolean;                                 // writes: may succeed more than once in a turn
  run(input: I, ctx: ToolContext): Promise<O> | O;
}
export interface Tool<I extends Record<string, any> = any, O = any> extends ToolDef<I, O> { kind: "read" | "write" }

export const read = <I extends Record<string, any>, O>(def: ToolDef<I, O>): Tool<I, O> => define("read", def);
export const write = <I extends Record<string, any>, O>(def: ToolDef<I, O>): Tool<I, O> => define("write", def);

function define<I extends Record<string, any>, O>(kind: "read" | "write", def: ToolDef<I, O>): Tool<I, O> {
  const fail = (why: string) => { throw new TypeError(`tool "${def?.name}": ${why}`); };
  if (!/^[a-z][a-z0-9_]*$/.test(def?.name ?? "")) fail("name must be explicit snake_case, e.g. get_account");
  if (!def.description) fail("description is required");
  if (!(def.input instanceof z.ZodObject)) fail("input must be a z.object(...)");
  if (typeof def.run !== "function") fail("run must be a function");
  if (kind === "read" && def.confirm) fail("confirm applies to write tools only");
  for (const [field, path] of Object.entries(def.bind ?? {})) {
    if (!(field in def.input.shape)) fail(`bind field "${field}" is not in the input schema`);
    if (!path.startsWith("facts.")) fail(`bind "${field}" must point at a session fact, e.g. "facts.accountId"`);
  }
  for (const field of def.fromCustomer ?? []) {
    if (!(field in def.input.shape)) fail(`fromCustomer field "${field}" is not in the input schema`);
    if (def.bind?.[field]) fail(`"${field}" can't be both bound and fromCustomer`);
  }
  return { ...def, kind };
}

/** What the model sees: name, description and the input schema without bound fields. */
export function toolSpec(tool: Tool): { name: string; description: string; inputSchema: Record<string, unknown> } {
  const bound = Object.fromEntries(Object.keys(tool.bind ?? {}).map((k) => [k, true as const]));
  const { $schema, ...inputSchema } = z.toJSONSchema(tool.input.omit(bound)) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, inputSchema };
}

// Field visibility. Listed paths ("plan.name", "invoices[].amount") are shown; with no list, fields with
// personal names are hidden and personal data inside other strings is masked; strict hides everything not listed.
export function visibleOutput(output: unknown, visible?: string[], strict = false): { value: Json; hidden: string[] } {
  const hidden: string[] = [];
  const listed = visible ? new Set(visible) : undefined;
  const walk = (v: any, path: string): any => {
    if (listed) {
      if (listed.has(path) || [...listed].some((p) => path.startsWith(p + ".") || path.startsWith(p + "[]"))) return v;
      if (path && ![...listed].some((p) => p.startsWith(path + ".") || p.startsWith(path + "[]"))) return undefined;
    } else if (strict) return undefined;
    else if (path && isPersonalName(path.split(/[.[\]]/).filter(Boolean).pop()!)) {
      hidden.push(path);
      return undefined;
    }
    if (Array.isArray(v)) {
      const kept = v.map((x) => walk(x, path + "[]")).filter((x) => x !== undefined);
      return kept.length || !v.length ? kept : undefined;
    }
    if (v && typeof v === "object") {
      const kept = Object.entries(v).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k)]).filter(([, x]) => x !== undefined);
      return kept.length || !Object.keys(v).length ? Object.fromEntries(kept) : undefined;
    }
    return listed ? undefined : typeof v === "string" ? maskText(v) : v;
  };
  return { value: walk(output, "") ?? null, hidden: [...new Set(hidden)] };
}

export interface RunOptions {
  strictVisibility?: boolean;
  run?: (input: any, ctx: ToolContext) => unknown;     // stand-in implementation (simulation)
}

/** Validate, inject bound fields, run, record. Returns the result and a new session; never throws for tool failures. */
export async function runTool(tool: Tool, modelInput: unknown, session: Session, opts: RunOptions = {}) {
  const turn = currentTurn(session);
  const id = "c_" + (session.results.length + 1);
  const raw = (modelInput && typeof modelInput === "object" ? { ...modelInput } : {}) as Record<string, any>;
  const done = (r: Omit<ToolResult, "id" | "tool" | "turn">, next: Session = session) =>
    ({ result: { id, tool: tool.name, turn, ...r } as ToolResult, session: { ...next, results: [...next.results, { id, tool: tool.name, turn, ...r }] } });
  const failed = (code: string, message: string, outcome?: "unknown") => done({ ok: false, input: raw, error: { code, message }, ...(outcome && { outcome }) });

  for (const [field, path] of Object.entries(tool.bind ?? {})) {
    const value = session.facts[path.slice("facts.".length)];
    if (value === undefined) return failed("missing_fact", `This call needs ${path}, which isn't known yet.`);
    raw[field] = value;                                   // overrides anything the model sent
  }
  const parsed = tool.input.safeParse(raw);
  if (!parsed.success) return failed("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));

  let output: unknown;
  try {
    output = await (opts.run ?? tool.run)(parsed.data, { facts: Object.freeze({ ...session.facts }), commitments: Object.freeze([...session.commitments]) });
  } catch (e) {
    return e instanceof ToolError ? failed(e.code, e.message, e.outcome) : failed("internal_error", "The tool failed unexpectedly.");
  }

  const rec = tool.records?.(output, parsed.data) ?? {};
  const next: Session = {
    ...session,
    facts: { ...session.facts, ...rec.facts },
    commitments: [...session.commitments, ...(rec.commitments ?? []).map((c) => ({ ...c, by: tool.name, turn, status: "open" as const }))],
  };
  const { value, hidden } = visibleOutput(output, tool.visible, opts.strictVisibility);
  let outcome: ToolResult["outcome"], outcomeError: string | undefined;
  try { outcome = tool.kind === "write" ? tool.outcome?.(output as never) ?? "done" : undefined; }
  catch (e) { outcome = "unknown"; outcomeError = (e as Error).message; }            // a broken outcome() can't be trusted either way
  return { ...done({ ok: true, input: parsed.data as Record<string, Json>, output: value, ...(outcome && { outcome }), ...(outcomeError && { outcomeError }) }, next), hidden };
}
