// Deterministic claim extraction and matching. Shared by the no_unconfirmed_claims check and the grader.
import type { CheckContext } from "./checks.js";
import type { Commitment, Json } from "./session.js";

export interface Claims { money: number[]; percents: number[]; dates: string[]; relative: string[]; done: string[] }

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?`;
const RELATIVE = /\b(today|tonight|tomorrow|yesterday|next (?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (?:week|weekend|month))\b/gi;
// A done phrase is negated when its own clause negates it: "haven't switched", "not yet", "nothing was switched",
// "none of your settings have been changed". Clauses split on punctuation and "but", so "No, it's done" and
// "No problem, your plan has been switched" keep their claims; "no problem"/"no worries" are interjections, never negations.
const NEGATED = /\b(?:not|never|no longer|nothing|none|no)\b|n't\b/i;
const INTERJECTION = /^\s*no (?:problem|worries|worry)\b/i;
// "You're all set staying on Starter" reports that nothing changed: status, not a claim that something was done.
// Failure wording is only honest after a known failure; after a success it's a false "it failed".
const FAILED_WORDS = /\b(?:didn't go through|did not go through|failed|wasn't applied|was not applied|nothing has changed|nothing has been changed|nothing was changed|no changes were made)\b/i;
const STATUS_AFTER = /^\s+(?:staying|to stay|on your (?:current|existing)|with your (?:current|existing))\b/i;
const DONE = /\b(?:(?:has|have) been (?:processed|cancell?ed|refunded|switched|changed|updated|applied|added|completed)|i(?:'ve| have) (?:cancell?ed|refunded|switched|changed|updated|processed|applied|added)|you're all set|you are all set|(?:it's|it is|that's) done|switched|successfully|went through|(?:has|have) gone through)\b/gi;

/** Normalize a number token: strip commas and currency, compare to the cent. */
export const normNumber = (s: string | number) => Math.round(parseFloat(String(s).replace(/[^\d.-]/g, "")) * 100) / 100;
const pad = (n: string | number) => String(n).padStart(2, "0");
const md = (m: number, d: string | number) => `${pad(m)}-${pad(d)}`;

export function extractClaims(text: string): Claims {
  const all = (re: RegExp) => [...text.matchAll(re)];
  const money = [
    ...all(new RegExp(String.raw`[$€£]\s?(${NUM})`, "g")).map((m) => m[1]),
    ...all(new RegExp(String.raw`(${NUM})\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\b`, "gi")).map((m) => m[1]),
  ].map(normNumber);
  const percents = all(new RegExp(String.raw`(${NUM})\s?(?:%|percent\b)`, "gi")).map((m) => normNumber(m[1]));
  const dates = [
    ...all(/\b(\d{4})-(\d{2})-(\d{2})(?!\d)/g).map((m) => `${m[1]}-${m[2]}-${m[3]}`),     // also inside ISO timestamps
    ...all(new RegExp(String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, "gi"))
      .map((m) => (m[3] ? `${m[3]}-` : "") + md(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, m[2])),
    ...all(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}(?:,?\s+(\d{4}))?\b`, "gi"))
      .map((m) => (m[3] ? `${m[3]}-` : "") + md(MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, m[1])),
    ...all(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g).filter((m) => +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31)
      .map((m) => (m[3] ? `${m[3]}-` : "") + md(+m[1], m[2])),
  ];
  const clauseBefore = (i: number) => (text.slice(0, i).split(/[.!?;:,\n]|\bbut\b/i).pop() ?? "").replace(INTERJECTION, "");
  const isStatus = (m: RegExpMatchArray) => /all set/i.test(m[0]) && STATUS_AFTER.test(text.slice(m.index! + m[0].length));
  const done = all(DONE).filter((m) => !NEGATED.test(clauseBefore(m.index!)) && !isStatus(m)).map((m) => m[0].toLowerCase());
  return { money, percents, dates, relative: all(RELATIVE).map((m) => m[0].toLowerCase()), done };
}

// A number's kind, from the name of the field holding it. Unknown fields hold plain numbers.
type Kind = "money" | "percent" | "plain";
const kindOf = (key: string): Kind => /percent|pct/i.test(key) ? "percent"
  : /price|charge|amount|savings|fee|cost|total|balance|increase|refund/i.test(key) ? "money" : "plain";

/** Every value a source confirms, by kind. Dates are kept as YYYY-MM-DD and MM-DD. */
export function confirmedValues(sources: (Json | undefined)[], texts: readonly string[] = []) {
  const ok = { money: new Set<number>(), percent: new Set<number>(), plain: new Set<number>(), dates: new Set<string>() };
  const addText = (s: string, kind: Kind) => {
    const c = extractClaims(s);
    c.money.forEach((n) => ok.money.add(n));                       // written form wins: "$4.99", "10%"
    c.percents.forEach((n) => ok.percent.add(n));
    for (const d of c.dates) { ok.dates.add(d); ok.dates.add(d.slice(-5)); }
    for (const m of s.matchAll(new RegExp(String.raw`(?<![\w.$€£])${NUM}(?![\w%])`, "g"))) ok[kind].add(normNumber(m[0]));   // not ids like acc_1
  };
  const walk = (v: Json | undefined, key: string): void => {
    if (typeof v === "number") ok[kindOf(key)].add(normNumber(v));
    else if (typeof v === "string") addText(v, kindOf(key));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, k));
  };
  sources.forEach((v) => walk(v, ""));
  texts.forEach((t) => addText(t, "plain"));
  return ok;
}

// A number only the customer said may be repeated inside a refusal that directly governs it: "I can't offer
// Plus at $10", "I'm not able to apply a 50% discount". Every other mention stays unconfirmed, including
// "I can't believe it's only $10" and a refusal followed by "…but your new price is $10".
// The refusal must be the agent's own ("I"/"we" as subject): "you won't get a better deal than $10" asserts a price.
const REFUSAL = /\b(?:i|we)(?:'m|'re|\s+am|\s+are)?\s+(?:can't|cannot|can not|won't|will not|unable to|not able to)\s+(?:offer|do|give|apply|get|set|lower|match|honou?r|reduce|provide|make)\b(?:\s+\S+){0,5}\s*$/i;
const COMPARATIVE = /\b(?:than|below|under|above|over|less|more|at least|at most|lowest|best|cheapest|minimum|maximum)\b/i;
const CLAUSE_BREAK = /[.!?;:,\n]|\b(?:but|because|and|so|although|though)\b/i;
function onlyInRefusals(text: string, kind: "money" | "percent", v: number): boolean {
  const re = kind === "money" ? new RegExp(String.raw`[$€£]\s?(${NUM})|(${NUM})\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\b`, "gi")
    : new RegExp(String.raw`(${NUM})\s?(?:%|percent\b)`, "gi");
  const hits = [...text.matchAll(re)].filter((m) => normNumber(m[1] ?? m[2]) === v);
  return hits.length > 0 && hits.every((m) => {
    const before = text.slice(0, m.index).split(CLAUSE_BREAK).pop() ?? "", after = text.slice(m.index).split(CLAUSE_BREAK)[0];
    return REFUSAL.test(before) && !COMPARATIVE.test(before + after);   // "I can't go lower than $10" sets a floor: not a refusal
  });
}

/** Why a draft reply isn't backed by this session's tools or the operator's text, or undefined if it is. */
export function unconfirmed(text: string, ctx: CheckContext, kinds: readonly ClaimKind[] = []): string | undefined {
  const c = extractClaims(text);
  const toolValues = [...ctx.results.filter((r) => r.ok).map((r) => r.output), ...ctx.commitments.map((k) => k.values as Json)];
  const ok = confirmedValues(toolValues, ctx.operatorText);
  const said = extractClaims(ctx.messages.filter((m) => m.role === "customer").map((m) => m.text).join("\n"));
  const refused = (kind: "money" | "percent", n: number) => (kind === "money" ? said.money : said.percents).includes(n) && onlyInRefusals(text, kind, n);
  const badMoney = c.money.find((n) => !ok.money.has(n) && !refused("money", n)), badPct = c.percents.find((n) => !ok.percent.has(n) && !refused("percent", n));
  if (badMoney !== undefined) return `Reply states the amount ${badMoney} but no tool returned that amount. Use a returned value or don't state it.`;
  if (badPct !== undefined) return `Reply states ${badPct}% but no tool returned that percentage. Use a returned value or don't state it.`;
  const badDate = c.dates.find((d) => !ok.dates.has(d));
  if (badDate) return `Reply states the date ${badDate} but no tool returned it. Use a returned date or don't state one.`;
  const relative = c.relative.filter((r) => r !== "today");       // "today" is confirmed by the agent's clock (ctx.now)
  if (relative.length && confirmedValues(toolValues).dates.size === 0)
    return `Reply says "${relative[0]}" but no tool returned a date this session. Don't promise timing no tool confirmed.`;
  // Write outcomes: each write's latest call is done, pending, failed, or unknown until a later reconcile read.
  // A write parked for a person's approval is "approval": requested, not done.
  const writes = ctx.tools.filter((t) => t.kind === "write");
  const latest = [...writes.map((t) => ({ t, i: ctx.results.findLastIndex((r) => r.tool === t.name) }))
    .filter(({ i }) => i >= 0).map(({ t, i }) => {
      const r = ctx.results[i], settled = t.reconcileWith && ctx.results.slice(i + 1).some((x) => x.ok && x.tool === t.reconcileWith);
      return { name: t.name, reconcileWith: t.reconcileWith, state: r.outcome === "unknown" ? (settled ? "reconciled" : "unknown") : r.ok ? r.outcome ?? "done" : "failed" };
    }), ...ctx.approvals.filter((a) => a.status === "pending" && writes.some((t) => t.name === a.tool))
    .map((a) => ({ name: a.tool, reconcileWith: undefined, state: "approval" }))];
  const has = (s: string) => latest.find((w) => w.state === s);
  const failedSaid = text.match(FAILED_WORDS)?.[0], unknown = has("unknown");
  if (unknown)                                                       // unknown: no reply at all until a read settles it (a handoff isn't a reply)
    return unknown.reconcileWith ? `Call ${unknown.reconcileWith} before replying; the outcome of ${unknown.name} is unknown.` : `The outcome of ${unknown.name} is unknown and nothing can check it; hand off to a person.`;
  if (failedSaid && !has("failed") && has("done"))
    return `Reply says "${failedSaid}", but nothing failed: the latest write succeeded. Say what actually happened.`;
  if (c.done.length) {
    const failed = latest.filter((w) => w.state === "failed").map((w) => w.name), pending = has("pending"), approval = has("approval");
    if (failed.length) return `Reply says "${c.done[0]}", but ${failed.join(", ")} failed and hasn't succeeded since. Say what actually happened.`;
    if (pending) return `Reply says "${c.done[0]}", but ${pending.name} is still pending. Say it's processing, not done.`;
    if (approval) return `Reply says "${c.done[0]}", but ${approval.name} is waiting for a person's approval. Say it's been requested, not done.`;
    const pleasantry = c.done.every((d) => /all set/.test(d));        // a bare "you're all set!" with no action verb
    if (!pleasantry && !has("done") && !has("reconciled")) return `Reply says "${c.done[0]}", but no write succeeded this session. Say what actually happened.`;
  }
  for (const k of kinds) {                                           // operator-defined kinds, after the built-in ones
    const find = finder(k), backs = k.confirms ?? ((v: Json) => texts(v).flatMap((t) => [t.toLowerCase(), ...find(t)]));
    const ok = new Set([...toolValues, ...ctx.operatorText].flatMap((v) => backs(v ?? null)));
    const bad = find(text).find((v) => !ok.has(v));
    if (bad !== undefined) return `Reply states the ${k.name} "${bad}" but no tool returned it. Use a returned value or don't state it.`;
  }
}

/**
 * An operator-defined claim kind: what to look for in a draft, and what a source must contain to back it.
 * Sources are successful tool outputs, commitment values and operator text, as for the built-in kinds.
 */
export interface ClaimKind {
  name: string;                                   // in the block reason: Reply states the <name> "<value>"…
  find: RegExp | ((text: string) => string[]);    // claims in a text; a RegExp yields its first group (else the match), lower-cased
  confirms?: (source: Json) => string[];          // what one source backs; default: each string or number in it, whole and lower-cased, plus find() over it
}
const finder = ({ find }: ClaimKind) => typeof find === "function" ? find
  : (text: string) => [...text.matchAll(new RegExp(find.source, find.flags.replace("g", "") + "g"))].map((m) => (m[1] ?? m[0]).toLowerCase());
const texts = (v: Json): string[] => typeof v === "string" ? [v] : typeof v === "number" ? [String(v)]
  : Array.isArray(v) ? v.flatMap(texts) : v && typeof v === "object" ? Object.values(v).flatMap(texts) : [];

/** Mark open commitments whose values appear in a sent reply as shown on this turn. */
export function markShown(commitments: Commitment[], reply: string, turn: number): Commitment[] {
  const c = extractClaims(reply);
  return commitments.map((k) => {
    const v = confirmedValues([k.values as Json]);
    const shown = reply.includes(k.id) || c.money.some((n) => v.money.has(n)) || c.percents.some((n) => v.percent.has(n));
    return k.shownTurn === undefined && k.status === "open" && shown ? { ...k, shownTurn: turn } : k;
  });
}
