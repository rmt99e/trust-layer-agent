import { allow, block, check, handoff, type Check, type ToolInfo } from "./checks.js";
import { unconfirmed } from "./claims.js";

// untrusted_text_is_data has no check here: bind injection (tools.ts) and fencing customer and
// tool text as data in the prompt (agent.ts) are structural, so there's nothing left to detect.

export interface BuiltinOptions {
  verified_first?: false;
  yes_after_quote?: false | { phrases?: string[] };
  no_unconfirmed_claims?: false;
  handoff_after_failures?: false | { after?: number };
}

const YES = ["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "go ahead", "do it", "please do", "confirm", "confirmed",
  "sounds good", "let's do it", "lets do it", "that works", "proceed", "absolutely", "correct", "agreed"];
const NOT_YES = /\b(no|not|nope|don't|dont|wait|hold on|hang on|cancel|stop|never|but)\b|n't\b|\?/i;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A clear yes: an affirmative phrase, and no negation, hedge or question. */
export function isAffirmative(text: string, phrases = YES): boolean {
  const t = text.toLowerCase().trim();
  return !NOT_YES.test(t) && phrases.some((p) => new RegExp(String.raw`(^|\b)${escape(p.toLowerCase())}\b`).test(t));
}

// After a quote was shown in an earlier reply, a request to go ahead is consent too. Questions aren't.
const PROCEED = /\b(?:(?:just |please )?switch me|switch it|go ahead|do it|make the (?:switch|change)|proceed|let's do (?:it|that)|(?:let's |i'll |i will )?go with (?:that|it|this)|i'll take (?:it|that)|i will take (?:it|that))\b/i;
const NOT_PROCEED = /\b(?:no|not|nope|don't|dont|wait|hold on|hang on|cancel|stop|never|but|cost|price|how much|fee|charge|details?|before you|what would|what will)\b|n't\b/i;
export const isProceed = (text: string) => PROCEED.test(text) && !NOT_PROCEED.test(text);

/** The warning the Agent constructor prints when verified_first can't do anything. */
export function verificationWarning(tools: readonly ToolInfo[]): string | undefined {
  if (!tools.some((t) => t.verifies))
    return "verified_first is OFF: no tool declares verifies: true. Account tools will run for unverified customers. " +
      "This doesn't apply to sessions your app creates with createSession({ facts: { verified } }); those are still checked.";
}

const verifiedFirst = check("verified_first", (e, ctx) => {
  if (e.kind !== "action" || e.tool.beforeVerification || ctx.facts.verified === true) return allow();
  const verifiers = ctx.tools.filter((t) => t.verifies).map((t) => t.name);
  if (!verifiers.length && !("verified" in ctx.facts)) return allow();     // off: nothing can verify
  return block(`Verify the customer before using ${e.tool.name}${verifiers.length ? ` (use ${verifiers.join(" or ")})` : ""}.`);
});

const yesAfterQuote = (phrases?: string[]) => check("yes_after_quote", (e, ctx) => {
  if (e.kind !== "action" || e.tool.kind !== "write" || e.tool.confirm === false) return allow();
  const lastAgent = ctx.messages.findLastIndex((m) => m.role === "agent");
  const last = ctx.messages.at(-1);
  const c = e.tool.confirm, id = c ? e.input[c.by] : undefined;
  const k = c ? ctx.commitments.find((x) => x.type === c.commitment && x.id === id) : undefined;
  const shownEarlier = k?.shownTurn !== undefined && k.shownTurn < ctx.turn;
  const consent = last?.role === "customer" && (isAffirmative(last.text, phrases) || (shownEarlier && isProceed(last.text)));
  if (lastAgent < 0 || !consent) return block(`Before ${e.tool.name}, tell the customer exactly what will happen and wait for a clear yes.`);
  if (!c) return allow();
  if (!k) return block(`No ${c.commitment} "${id}" exists in this conversation. Create one and show it to the customer first.`);
  if (k.status !== "open") return block(`${c.commitment} "${id}" was already used. Create a new one.`);
  if (k.expiresAt && new Date(k.expiresAt) <= ctx.now) return block(`${c.commitment} "${id}" has expired. Create a new one and show it.`);
  if (k.shownTurn === undefined || k.shownTurn >= ctx.turn)
    return block(`Show the customer ${c.commitment} "${id}" (its price) and wait for a yes after it before ${e.tool.name}.`);
  return allow();
});

const noUnconfirmedClaims = check("no_unconfirmed_claims", (e, ctx) => {
  const why = e.kind === "reply" ? unconfirmed(e.text, ctx) : undefined;
  return why ? block(why) : allow();
});

const handoffAfterFailures = (after = 2) => check("handoff_after_failures", (_e, ctx) => {
  if (ctx.failures < after) return allow();
  const errors = ctx.results.filter((r) => !r.ok).slice(-after).map((r) => `${r.tool}: ${r.error?.code}`);
  return handoff(`${ctx.failures} consecutive failures${errors.length ? ` (${errors.join("; ")})` : ""}.`);
});

/** Built-in names a journey may list. untrusted_text_is_data is structural and always on. */
export const BUILTIN_NAMES = ["verified_first", "yes_after_quote", "no_unconfirmed_claims", "handoff_after_failures", "untrusted_text_is_data"] as const;

export function builtinChecks(opts: BuiltinOptions = {}): Check[] {
  return [
    opts.verified_first !== false && verifiedFirst,
    opts.yes_after_quote !== false && yesAfterQuote(opts.yes_after_quote?.phrases),
    opts.no_unconfirmed_claims !== false && noUnconfirmedClaims,
    opts.handoff_after_failures !== false && handoffAfterFailures(opts.handoff_after_failures?.after),
  ].filter((c): c is Check => Boolean(c));
}

/** The full chain for an event: built-ins first, then journey guardrails, then custom checks. */
export const checkPipeline = (opts: BuiltinOptions = {}, guardrails: Check[] = [], custom: Check[] = []): Check[] =>
  [...builtinChecks(opts), ...guardrails, ...custom];
