// Deterministic claim extraction and matching. Shared by the no_unconfirmed_claims check and the grader.
import type { CheckContext } from "./checks.js";
import type { Commitment, Json } from "./session.js";

export interface Claims { money: number[]; percents: number[]; dates: string[]; relative: string[]; done: string[] }

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?`;
const RELATIVE = /\b(today|tonight|tomorrow|yesterday|next (?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (?:week|weekend|month))\b/gi;
const DONE = /\b(?:(?:has|have) been (?:processed|cancell?ed|refunded|switched|changed|updated|applied|added|completed)|i(?:'ve| have) (?:cancell?ed|refunded|switched|changed|updated|processed|applied|added)|you're all set|you are all set|(?:it's|it is|that's) done|switched|successfully)\b/gi;

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
    ...all(/\b(\d{4})-(\d{2})-(\d{2})\b/g).map((m) => `${m[1]}-${m[2]}-${m[3]}`),
    ...all(new RegExp(String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, "gi"))
      .map((m) => (m[3] ? `${m[3]}-` : "") + md(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, m[2])),
    ...all(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}(?:,?\s+(\d{4}))?\b`, "gi"))
      .map((m) => (m[3] ? `${m[3]}-` : "") + md(MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, m[1])),
    ...all(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g).filter((m) => +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31)
      .map((m) => (m[3] ? `${m[3]}-` : "") + md(+m[1], m[2])),
  ];
  return { money, percents, dates, relative: all(RELATIVE).map((m) => m[0].toLowerCase()), done: all(DONE).map((m) => m[0].toLowerCase()) };
}

/** Every number and date a source confirms. Dates are kept as YYYY-MM-DD and MM-DD. */
export function confirmedValues(sources: (Json | undefined)[], texts: readonly string[] = []) {
  const numbers = new Set<number>(), dates = new Set<string>();
  const addText = (s: string) => {
    for (const m of s.matchAll(new RegExp(String.raw`(?<![\w.])${NUM}(?![\w])`, "g"))) numbers.add(normNumber(m[0]));   // not ids like acc_1
    for (const d of extractClaims(s).dates) { dates.add(d); dates.add(d.slice(-5)); }
  };
  const walk = (v: Json | undefined): void => {
    if (typeof v === "number") numbers.add(normNumber(v));
    else if (typeof v === "string") addText(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  sources.forEach(walk);
  texts.forEach(addText);
  return { numbers, dates };
}

/** Why a draft reply isn't backed by this session's tools or the operator's text, or undefined if it is. */
export function unconfirmed(text: string, ctx: CheckContext): string | undefined {
  const c = extractClaims(text);
  const toolValues = [...ctx.results.filter((r) => r.ok).map((r) => r.output), ...ctx.commitments.map((k) => k.values as Json)];
  const ok = confirmedValues(toolValues, ctx.operatorText);
  const bad = [...c.money, ...c.percents].find((n) => !ok.numbers.has(n));
  if (bad !== undefined) return `Reply states ${bad} but no tool returned ${bad}. Use a returned value or don't state it.`;
  const badDate = c.dates.find((d) => !ok.dates.has(d));
  if (badDate) return `Reply states the date ${badDate} but no tool returned it. Use a returned date or don't state one.`;
  if (c.relative.length && confirmedValues(toolValues).dates.size === 0)
    return `Reply says "${c.relative[0]}" but no tool returned a date this session. Don't promise timing no tool confirmed.`;
  if (c.done.length) {
    const writes = new Set(ctx.tools.filter((t) => t.kind === "write").map((t) => t.name));
    const calls = ctx.results.filter((r) => writes.has(r.tool));
    const unresolved = [...new Set(calls.filter((r, i) => !r.ok && !calls.slice(i + 1).some((l) => l.tool === r.tool && l.ok)).map((r) => r.tool))];
    if (unresolved.length)
      return `Reply says "${c.done[0]}", but ${unresolved.join(", ")} failed and hasn't succeeded since. Say what actually happened.`;
    if (!calls.some((r) => r.ok)) return `Reply says "${c.done[0]}", but no write succeeded this session. Say what actually happened.`;
  }
}

/** Mark open commitments whose values appear in a sent reply as shown on this turn. */
export function markShown(commitments: Commitment[], reply: string, turn: number): Commitment[] {
  const c = extractClaims(reply);
  const said = new Set([...c.money, ...c.percents]);
  return commitments.map((k) => k.shownTurn === undefined && k.status === "open" &&
    (reply.includes(k.id) || [...confirmedValues([k.values as Json]).numbers].some((n) => said.has(n))) ? { ...k, shownTurn: turn } : k);
}
