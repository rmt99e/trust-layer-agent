import { allow, block, check, handoff, type Check, type ToolInfo } from "./checks.js";
import { escapeRegExp, unconfirmed, type ClaimKind } from "./claims.js";
import { leaves, type Json } from "./session.js";

// untrusted_text_is_data has no check here: bind injection (tools.ts) and fencing user and
// tool text as data in the prompt (agent.ts) are structural, so there's nothing left to detect.

export interface BuiltinOptions {
  verified_first?: false;
  yes_after_quote?: false | { phrases?: string[] };
  no_unconfirmed_claims?: false | { kinds?: ClaimKind[] };   // kinds: operator-defined claims, checked after the built-in ones
  handoff_after_failures?: false | { after?: number };
  no_repeated_writes?: false;
  no_invented_inputs?: false;
}

const YES = ["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "go ahead", "do it", "please do", "confirm", "confirmed",
  "sounds good", "let's do it", "lets do it", "that works", "proceed", "absolutely", "correct", "agreed"];
const NOT_YES = /\b(no|not|nope|don't|dont|wait|hold on|hang on|cancel|stop|never|but)\b|n't\b|\?/i;   // any question mark is a hedge, not a yes

/** A clear yes: an affirmative phrase, and no negation, hedge or question. */
export function isAffirmative(text: string, phrases = YES): boolean {
  const t = text.toLowerCase().trim();
  return !NOT_YES.test(t) && phrases.some((p) => new RegExp(String.raw`(^|\b)${escapeRegExp(p.toLowerCase())}\b`).test(t));
}

// After a quote was shown in an earlier reply, a request to go ahead is consent too. Questions aren't.
const PROCEED = /\b(?:(?:just |please )?switch me|switch it|go ahead|do it|make the (?:switch|change)|proceed|let's do (?:it|that)|(?:let's |i'll |i will )?go with (?:that|it|this)|i'll take (?:it|that)|i will take (?:it|that))\b/i;
const NOT_PROCEED = /\b(?:no|not|nope|don't|dont|wait|hold on|hang on|cancel|stop|never|but|cost|price|how much|fee|charge|details?|before you|what would|what will)\b|n't\b/i;
export const isProceed = (text: string) => PROCEED.test(text) && !NOT_PROCEED.test(text);

/** The warning the Agent constructor prints when verified_first can't do anything. */
export function verificationWarning(tools: readonly ToolInfo[]): string | undefined {
  if (!tools.some((t) => t.verifies))
    return "verified_first is OFF: no tool declares verifies: true. Account tools will run for unverified users. " +
      "This doesn't apply to sessions your app creates with createSession({ facts: { verified } }); those are still checked.";
}

const verifiedFirst = check("verified_first", (e, ctx) => {
  if (e.kind !== "action" || e.tool.beforeVerification || ctx.facts.verified === true) return allow();
  const verifiers = ctx.tools.filter((t) => t.verifies).map((t) => t.name);
  if (!verifiers.length && !("verified" in ctx.facts)) return allow();     // off: nothing can verify
  return block(`Verify the user before using ${e.tool.name}${verifiers.length ? ` (use ${verifiers.join(" or ")})` : ""}.`);
});

// One yes covers the turn: any unconfirmed write the model calls after it runs. A write with `confirm` is also tied to
// its commitment, which must exist, be open and unexpired, and have been shown in an earlier reply.
const yesAfterQuote = (phrases?: string[]) => check("yes_after_quote", (e, ctx) => {
  if (e.kind !== "action" || e.tool.kind !== "write" || e.tool.confirm === false) return allow();
  const lastAgent = ctx.messages.findLastIndex((m) => m.role === "agent");
  const last = ctx.messages.at(-1);
  const c = e.tool.confirm, id = c ? e.input[c.by] : undefined;
  const k = c ? ctx.commitments.find((x) => x.type === c.commitment && x.id === id) : undefined;
  const shownEarlier = k?.shownTurn !== undefined && k.shownTurn < ctx.turn;
  const consent = last?.role === "user" && (isAffirmative(last.text, phrases) || (shownEarlier && isProceed(last.text)));
  if (lastAgent < 0 || !consent) return block(`Before ${e.tool.name}, tell the user exactly what will happen and wait for a clear yes.`);
  if (!c) return allow();
  if (!k) return block(`No ${c.commitment} "${id}" exists in this conversation. Create one and show it to the user first.`);
  if (k.status !== "open") return block(`${c.commitment} "${id}" was already used. Create a new one.`);
  if (k.expiresAt && new Date(k.expiresAt) <= ctx.now) return block(`${c.commitment} "${id}" has expired. Create a new one and show it.`);
  if (k.shownTurn === undefined || k.shownTurn >= ctx.turn)
    return block(`Show the user ${c.commitment} "${id}" (its price) and wait for a yes after it before ${e.tool.name}.`);
  return allow();
});

const noUnconfirmedClaims = (kinds?: ClaimKind[]) => check("no_unconfirmed_claims", (e, ctx) => {
  const why = e.kind === "reply" ? unconfirmed(e.text, ctx, kinds) : undefined;
  return why ? block(why) : allow();
});

// Inputs a tool declares fromUser must be values the user gave: each leaf (string or number) appears whole,
// case-insensitively, in a user message, or equals a session fact. Tool output is never a source: data a tool
// discovered is output, not something the user asked about.
const squash = (s: string) => s.trim().replace(/\s+/g, " ");
const noInventedInputs = check("no_invented_inputs", (e, ctx) => {
  if (e.kind !== "action" || !e.tool.fromUser?.length) return allow();
  const said = squash(ctx.messages.filter((m) => m.role === "user").map((m) => m.text).join("\n"));
  const known = leaves(ctx.facts as Json).map((f) => String(f).toLowerCase());
  const gave = (v: string | number) => {
    const t = squash(String(v));
    return !t || known.includes(t.toLowerCase()) || new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${escapeRegExp(t)}(?=$|[^\p{L}\p{N}])`, "iu").test(said);
  };
  for (const field of e.tool.fromUser) {
    const bad = leaves(e.input[field]).find((v) => !gave(v));
    if (bad !== undefined) return block(`The user never said "${bad}" (${field} in ${e.tool.name}). Use only values the user gave, or ask them.`);
  }
  return allow();
});

// A write that already succeeded this turn isn't repeated (e.g. opening another case while redrafting a reply).
// An unknown or pending outcome may already have applied, so it can't be retried this turn either (even if repeatable).
const noRepeatedWrites = check("no_repeated_writes", (e, ctx) => {
  if (e.kind !== "action" || e.tool.kind !== "write") return allow();
  const unanswered = (turn: number) => turn === ctx.turn || !ctx.messages.some((m) => m.role === "agent" && m.turn === turn);   // this turn, or one that failed
  const prior = ctx.results.findLast((r) => r.tool === e.tool.name && unanswered(r.turn) && (r.ok || r.outcome === "unknown"));
  const unsettled = prior && (prior.outcome === "unknown" || prior.outcome === "pending");
  if (!prior || (e.tool.repeatable && !unsettled)) return allow();
  if (unsettled) {
    const recheck = e.tool.reconcileWith ? `; call ${e.tool.reconcileWith} to check what happened` : "";
    return block(`${e.tool.name}'s last call this turn has an ${prior.outcome} outcome and may already have applied. Don't retry it${recheck}.`);
  }
  return block(`${e.tool.name} already succeeded this turn (result: ${JSON.stringify(prior.output)}). Don't call it again; use that result.`);
});

const handoffAfterFailures = (after = 2) => check("handoff_after_failures", (_e, ctx) => {
  if (ctx.failures < after) return allow();
  const errors = ctx.results.filter((r) => !r.ok).slice(-after).map((r) => `${r.tool}: ${r.error?.code}`);
  return handoff(`${ctx.failures} consecutive failures${errors.length ? ` (${errors.join("; ")})` : ""}.`);
});

/** Built-in names a journey may list. untrusted_text_is_data is structural and always on. */
export const BUILTIN_NAMES = ["verified_first", "yes_after_quote", "no_unconfirmed_claims", "handoff_after_failures", "no_repeated_writes", "no_invented_inputs", "untrusted_text_is_data"] as const;

/** The operator-defined claim kinds in effect, for the grader and the snapshot fingerprint. */
export const claimKinds = (opts: BuiltinOptions = {}): ClaimKind[] => (opts.no_unconfirmed_claims && opts.no_unconfirmed_claims.kinds) || [];

export function builtinChecks(opts: BuiltinOptions = {}): Check[] {
  return [
    opts.verified_first !== false && verifiedFirst,
    opts.yes_after_quote !== false && yesAfterQuote(opts.yes_after_quote?.phrases),
    opts.no_unconfirmed_claims !== false && noUnconfirmedClaims(claimKinds(opts)),
    opts.handoff_after_failures !== false && handoffAfterFailures(opts.handoff_after_failures?.after),
    opts.no_repeated_writes !== false && noRepeatedWrites,
    opts.no_invented_inputs !== false && noInventedInputs,
  ].filter((c): c is Check => Boolean(c));
}

/** The full chain for an event: built-ins first, then journey guardrails, then custom checks. */
export const checkPipeline = (opts: BuiltinOptions = {}, guardrails: Check[] = [], custom: Check[] = []): Check[] =>
  [...builtinChecks(opts), ...guardrails, ...custom];
