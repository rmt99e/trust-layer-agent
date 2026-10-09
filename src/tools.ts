import { z } from "zod";
import { isPersonalName, maskText } from "./privacy.js";
import { currentTurn, FACTS_PREFIX, HANDOFF_TOOL, nextResultId, type Commitment, type Json, type Session, type ToolResult } from "./session.js";

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

type Shape = z.ZodObject<any>;
type Field<S extends Shape> = keyof z.output<S> & string;

/** A tool declaration. The input schema types `run`, `records`, `bind`, `fromUser` and `confirm.by`. */
export interface ToolDef<S extends Shape = Shape, O = any> {
  name: string;
  description: string;
  input: S;
  visible?: string[];                                              // output paths the model may see; see visibleOutput
  bind?: Partial<Record<Field<S>, `${typeof FACTS_PREFIX}${string}`>>;   // { accountId: "facts.accountId" }
  fromUser?: Field<S>[];                                           // inputs whose values must come from the user's own words or a fact
  secret?: Field<S>[];                                             // inputs kept out of the session and traces once the call has run
  confirm?: false | { commitment: string; by: Field<S> };          // writes only
  beforeVerification?: boolean;
  verifies?: boolean;
  records?(output: O, input: z.output<S>): Records;
  outcome?(output: O): "done" | "pending";                         // writes: how to read a successful result (default "done")
  reconcileWith?: string;                                          // writes: the read tool that settles an unknown outcome
  repeatable?: boolean;                                            // writes: may succeed more than once in a turn
  run(input: z.output<S>, ctx: ToolContext): Promise<O> | O;
}
export interface Tool<S extends Shape = Shape, O = any> extends ToolDef<S, O> { kind: "read" | "write" }

export const read = <S extends Shape, O>(def: ToolDef<S, O>): Tool<S, O> => define("read", def);
export const write = <S extends Shape, O>(def: ToolDef<S, O>): Tool<S, O> => define("write", def);

function define<S extends Shape, O>(kind: "read" | "write", def: ToolDef<S, O>): Tool<S, O> {
  const fail = (why: string) => { throw new TypeError(`tool "${def?.name}": ${why}`); };
  if (!/^[a-z][a-z0-9_]*$/.test(def?.name ?? "")) fail("name must be explicit snake_case, e.g. get_account");
  if (!def.description) fail("description is required");
  if (!(def.input instanceof z.ZodObject)) fail("input must be a z.object(...)");
  if (typeof def.run !== "function") fail("run must be a function");
  if (kind === "read" && def.confirm) fail("confirm applies to write tools only");
  for (const [field, path] of Object.entries(def.bind ?? {}) as [string, string][]) {
    if (!(field in def.input.shape)) fail(`bind field "${field}" is not in the input schema`);
    if (!path.startsWith(FACTS_PREFIX)) fail(`bind "${field}" must point at a session fact, e.g. "facts.accountId"`);
  }
  for (const field of def.fromUser ?? []) {
    if (!(field in def.input.shape)) fail(`fromUser field "${field}" is not in the input schema`);
    if (def.bind?.[field]) fail(`"${field}" can't be both bound and fromUser`);
  }
  for (const field of def.secret ?? []) {
    if (!(field in def.input.shape)) fail(`secret field "${field}" is not in the input schema`);
    if (def.bind?.[field] || (def.confirm && def.confirm.by === field)) fail(`secret field "${field}" can't be bound or a confirm.by field`);
  }
  const confirm = def.confirm ?? (def.name === HANDOFF_TOOL ? false : undefined);   // the reserved handoff write needs no yes
  return { ...def, ...(confirm !== undefined && { confirm }), kind };
}

const boundFields = (tool: Tool) => Object.keys(tool.bind ?? {});
/** The input schema without bound fields: what the model fills in. */
export const unboundSchema = (tool: Tool) => tool.input.omit(Object.fromEntries(boundFields(tool).map((k) => [k, true as const])));
/** An input without its bound fields: what the model is shown or asked for. */
export const unboundInput = <T>(tool: Tool, input: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(input).filter(([k]) => !boundFields(tool).includes(k)));

export const REDACTED = "[redacted]";
/** An input with its secret fields replaced: what the session, the traces and the model's history keep of a call. */
export const redactInput = <T>({ secret }: Pick<Tool, "secret">, input: Record<string, T>): Record<string, T | string> =>
  secret?.length ? { ...input, ...Object.fromEntries(secret.filter((k) => k in input).map((k) => [k, REDACTED])) } : input;

/** What the model sees: name, description and the input schema without bound fields. */
export function toolSpec(tool: Tool): { name: string; description: string; inputSchema: Record<string, unknown> } {
  const { $schema, ...inputSchema } = z.toJSONSchema(unboundSchema(tool)) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, inputSchema };
}

// Field visibility. Listed paths ("plan.name", "invoices[].amount") are shown; with no list, fields with
// personal names are hidden and personal data inside other strings is masked; strict hides everything not listed.
export function visibleOutput(output: Json, visible?: string[], strict = false): { value: Json; hidden: string[] } {
  const hidden: string[] = [];
  const listed = visible ? new Set(visible) : undefined;
  const walk = (v: Json, path: string): Json | undefined => {
    if (listed) {
      if (listed.has(path) || [...listed].some((p) => path.startsWith(p + ".") || path.startsWith(p + "[]"))) return v;
      if (path && ![...listed].some((p) => p.startsWith(path + ".") || p.startsWith(path + "[]"))) return undefined;
    } else if (strict) return undefined;
    else if (path && isPersonalName(path.split(/[.[\]]/).filter(Boolean).pop() ?? "")) {
      hidden.push(path);
      return undefined;
    }
    if (Array.isArray(v)) {
      const kept = v.map((x) => walk(x, path + "[]")).filter((x): x is Json => x !== undefined);
      return kept.length || !v.length ? kept : undefined;
    }
    if (v && typeof v === "object") {
      const kept = Object.entries(v).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k)] as const).filter((e): e is readonly [string, Json] => e[1] !== undefined);
      return kept.length || !Object.keys(v).length ? Object.fromEntries(kept) : undefined;
    }
    return listed ? undefined : typeof v === "string" ? maskText(v) : v;
  };
  return { value: walk(output, "") ?? null, hidden: [...new Set(hidden)] };
}

export interface RunOptions { strictVisibility?: boolean }

/** Validate, inject bound fields, run, record. Returns the result and a new session; never throws for tool failures. */
export async function runTool(tool: Tool, modelInput: unknown, session: Session, opts: RunOptions = {}) {
  const turn = currentTurn(session), id = nextResultId(session);
  const raw = (modelInput && typeof modelInput === "object" ? { ...modelInput } : {}) as Record<string, Json>;
  const done = (r: Omit<ToolResult, "id" | "tool" | "turn">, next: Session = session) => {
    const result: ToolResult = { id, tool: tool.name, turn, ...r };
    return { result, session: { ...next, results: [...next.results, result] } };
  };
  const failed = (code: string, message: string, outcome?: "unknown") =>
    done({ ok: false, input: redactInput(tool, raw), error: { code, message }, ...(outcome && { outcome }) });

  for (const [field, path] of Object.entries(tool.bind ?? {}) as [string, string][]) {
    const value = session.facts[path.slice(FACTS_PREFIX.length)];
    if (value === undefined) return failed("missing_fact", `This call needs ${path}, which isn't known yet.`);
    raw[field] = value;                                   // overrides anything the model sent
  }
  const placeholder = tool.secret?.find((k) => raw[k] === REDACTED);                 // the model echoing history, not a value
  if (placeholder) return failed("invalid_input", `${placeholder}: "${REDACTED}" is a placeholder for an earlier call's value, not a value; ask for it again.`);
  const parsed = tool.input.safeParse(raw);
  if (!parsed.success) return failed("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));

  let returned: unknown;
  try {
    returned = await tool.run(parsed.data, { facts: Object.freeze({ ...session.facts }), commitments: Object.freeze([...session.commitments]) });
  } catch (e) {
    return e instanceof ToolError ? failed(e.code, e.message, e.outcome) : failed("internal_error", "The tool failed unexpectedly.");
  }
  // Tools return data. A Date becomes its ISO string, undefined and functions vanish; what can't be JSON is a failure
  // (for a write, one whose effect may have applied).
  let output: Json;
  try { output = returned === undefined ? null : JSON.parse(JSON.stringify(returned)); }
  catch { return failed("not_json", "The tool returned a value that isn't JSON.", tool.kind === "write" ? "unknown" : undefined); }

  let rec: Records = {}, recordsError: string | undefined;
  try { rec = tool.records?.(output, parsed.data) ?? {}; } catch (e) { recordsError = (e as Error).message; }   // a broken records() records nothing
  const next: Session = {
    ...session,
    facts: { ...session.facts, ...rec.facts },
    commitments: [...session.commitments, ...(rec.commitments ?? []).map((c) => ({ ...c, by: tool.name, turn, status: "open" as const }))],
  };
  const { value } = visibleOutput(output, tool.visible, opts.strictVisibility);
  let outcome: ToolResult["outcome"], outcomeError: string | undefined;
  try { outcome = tool.kind === "write" ? tool.outcome?.(output) ?? "done" : undefined; }
  catch (e) { outcome = "unknown"; outcomeError = (e as Error).message; }            // a broken outcome() can't be trusted either way
  if (recordsError && tool.kind === "write") outcome = "unknown";                     // nor can a write whose records() broke
  return done({ ok: true, input: redactInput(tool, parsed.data as Record<string, Json>), output: value, ...(outcome && { outcome }),
    ...(outcomeError && { outcomeError }), ...(recordsError && { recordsError }) }, next);
}
