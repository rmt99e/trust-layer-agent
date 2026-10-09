import { z } from "zod";
import { allow, block, check, handoff, type Check, type CheckContext } from "./checks.js";
import { escapeRegExp } from "./claims.js";
import { fromZod, listFiles, readYaml, where, type Issue } from "./files.js";
import type { Json } from "./session.js";

// Guidance is a prompt; only guardrails are enforced. Guardrails are check names or one of these kinds.
const str = z.string().min(1);
const KINDS = {
  require_call_before: z.object({ tool: str, call: str }).strict(),
  allow_values: z.object({ tool: str, input: str, from: str, field: str }).strict(),
  max_calls: z.object({ tool: str, per_session: z.number().int().positive() }).strict(),
  require_fact: z.object({ tool: str, fact: str }).strict(),
  handoff_when: z.object({
    tool_result: z.object({ tool: str, field: str, equals: z.any().optional(), in: z.array(z.any()).optional() }).strict().optional(),
    tool_error: z.object({ tool: str, code: str }).strict().optional(),
    user_says: z.array(str).min(1).optional(),
    fact: z.object({ name: str, equals: z.any() }).strict().optional(),
    summary: str,
  }).strict().refine((h) => [h.tool_result, h.tool_error, h.user_says, h.fact].filter(Boolean).length === 1,
    "handoff_when needs exactly one of tool_result, tool_error, user_says or fact"),
};
type Kind = keyof typeof KINDS;
type Spec<K extends Kind> = z.infer<(typeof KINDS)[K]>;
type Rail = { [K in Kind]: { kind: K; spec: Spec<K> } }[Kind];
const JourneyFile = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be lowercase-with-dashes"), goal: str, when: str.optional(),
  guidance: z.array(str).min(1), done_when: z.array(str).optional(), guardrails: z.array(z.unknown()).default([]),
}).strict();

export interface LoadedJourneys { prompts: string[]; checks: Check[]; handoffs: ((ctx: CheckContext) => string | undefined)[] }

/** Values at a path like "plans[].id" in a tool's visible output. */
const pluck = (v: unknown, path: string): unknown[] => path.split(".").reduce<unknown[]>((vals, seg) => vals.flatMap((x) => {
  const many = seg.endsWith("[]"), y = (x as Record<string, unknown> | undefined)?.[many ? seg.slice(0, -2) : seg];
  return many ? (Array.isArray(y) ? y : []) : y === undefined ? [] : [y];
}), [v]);

/** Load, validate and compile journeys. Throws one error listing every problem as file:line:col. */
export function loadJourneys(paths: string | string[], known: { tools: string[]; checks: string[]; disabled: string[] }): LoadedJourneys {
  const out: LoadedJourneys = { prompts: [], checks: [], handoffs: [] }, ids = new Set<string>();
  for (const file of listFiles(paths)) {
    const { doc, lines } = readYaml(file);
    const parsed = JourneyFile.safeParse(doc.toJS());
    const issues: Issue[] = parsed.success ? [] : fromZod(parsed.error);
    const j = parsed.success ? parsed.data : undefined;
    const needTool = (t: string, path: (string | number)[]) => { if (!known.tools.includes(t)) issues.push({ path, message: `unknown tool "${t}"` }); };
    const rails = (j?.guardrails ?? []).map((g, i): Rail | undefined => {
      if (typeof g === "string") {
        if (known.disabled.includes(g)) issues.push({ path: ["guardrails", i], message: `check "${g}" is disabled in builtins` });
        else if (!known.checks.includes(g)) issues.push({ path: ["guardrails", i], message: `unknown check "${g}"` });
        return undefined;
      }
      const kind = g && typeof g === "object" && Object.keys(g).length === 1 ? Object.keys(g)[0] as Kind : undefined;
      if (!kind || !(kind in KINDS)) return void issues.push({ path: ["guardrails", i], message: `unknown guardrail; use a check name or one of ${Object.keys(KINDS).join(", ")}` });
      const r = KINDS[kind].safeParse((g as Record<string, unknown>)[kind]);
      if (!r.success) return void issues.push(...fromZod(r.error, ["guardrails", i, kind]));
      const spec = r.data as Record<string, any>;
      for (const f of ["tool", "call", "from"]) if (spec[f]) needTool(spec[f], ["guardrails", i, kind, f]);
      if (spec.tool_result) needTool(spec.tool_result.tool, ["guardrails", i, kind, "tool_result", "tool"]);
      if (spec.tool_error) needTool(spec.tool_error.tool, ["guardrails", i, kind, "tool_error", "tool"]);
      return { kind, spec } as Rail;
    });
    if (j && ids.has(j.id)) issues.push({ path: ["id"], message: `duplicate journey id "${j.id}"` });
    if (issues.length) throw new Error("Invalid journey:\n" + issues.map((i) => "  " + where(file, doc, lines, i)).join("\n"));
    ids.add(j!.id);
    out.prompts.push(render(j!));
    for (const r of rails) if (r) compile(j!.id, r, out);
  }
  return out;
}

const render = (j: z.infer<typeof JourneyFile>) => [`## Journey: ${j.id}`, `Goal: ${j.goal}`, j.when && `Use when: ${j.when}`,
  "Guidance:", ...j.guidance.map((g) => `- ${g}`), ...(j.done_when ? ["Done when:", ...j.done_when.map((d) => `- ${d}`)] : [])].filter(Boolean).join("\n");

const okOf = (ctx: CheckContext, tool: string) => ctx.results.filter((r) => r.ok && r.tool === tool);

/** When a handoff_when guardrail is due: on a phrase or a fact (checked before the model is called too), or on a tool result or error once it lands. */
function dueWhen(s: Spec<"handoff_when">): (ctx: CheckContext) => string | undefined {
  const hit = (ctx: CheckContext): boolean => {
    if (s.user_says) {
      const said = ctx.messages.findLast((m) => m.role === "user")?.text.toLowerCase() ?? "";
      return s.user_says.some((p) => new RegExp(String.raw`\b${escapeRegExp(p.toLowerCase())}\b`).test(said));
    }
    if (s.tool_error) return ctx.results.some((r) => r.tool === s.tool_error!.tool && r.error?.code === s.tool_error!.code);
    if (s.tool_result) return okOf(ctx, s.tool_result.tool).some((r) => pluck(r.output, s.tool_result!.field)
      .some((v) => s.tool_result!.in ? s.tool_result!.in.includes(v) : v === s.tool_result!.equals));
    return ctx.facts[s.fact!.name] === s.fact!.equals;
  };
  return (ctx) => (hit(ctx) ? s.summary : undefined);
}

function compile(id: string, rail: Rail, out: LoadedJourneys) {
  const on = (tool: string, fn: (input: Record<string, Json>, ctx: CheckContext) => string | undefined) =>
    out.checks.push(check(`${id}:${rail.kind}`, (e, ctx) => {
      const why = e.kind === "action" && e.tool.name === tool ? fn(e.input, ctx) : undefined;
      return why ? block(why) : allow();
    }));
  switch (rail.kind) {
    case "require_call_before": { const s = rail.spec; on(s.tool, (_, ctx) => okOf(ctx, s.call).length ? undefined : `Call ${s.call} before ${s.tool}.`); break; }
    case "max_calls": { const s = rail.spec; on(s.tool, (_, ctx) => okOf(ctx, s.tool).length >= s.per_session ? `${s.tool} can only be used ${s.per_session} time(s) per conversation.` : undefined); break; }
    case "require_fact": { const s = rail.spec; on(s.tool, (_, ctx) => ctx.facts[s.fact] ? undefined : `${s.tool} needs the fact "${s.fact}" first.`); break; }
    case "allow_values": {
      const s = rail.spec;
      on(s.tool, (input, ctx) => {
        if (input[s.input] === undefined) return;
        const calls = okOf(ctx, s.from), allowed = calls.flatMap((r) => pluck(r.output, s.field));
        const list = allowed.join(", ") || (calls.length ? "none" : "not called yet");
        return allowed.includes(input[s.input]) ? undefined : `${s.input} must be one of the values ${s.from} returned (${list}).`;
      });
      break;
    }
    case "handoff_when": {
      const due = dueWhen(rail.spec);
      out.handoffs.push(due);
      out.checks.push(check(`${id}:handoff_when`, (_e, ctx) => { const why = due(ctx); return why ? handoff(why) : allow(); }));
    }
  }
}
