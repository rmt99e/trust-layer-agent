import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { maskText } from "./privacy.js";

/**
 * Where trace lines go. The Agent masks every line before calling write(), whatever the sink, unless the sink
 * sets mask: false. forget(sessionId) deletes a session's lines; Agent.forget() calls it when it exists.
 */
export interface TraceSink { write(line: Record<string, unknown>): void; forget?(sessionId: string): void; mask?: boolean }

/** Mask emails, phone numbers, card numbers, SSNs and street addresses in every string inside a value. */
export const maskTrace = (v: unknown): unknown =>
  typeof v === "string" ? maskText(v)
  : Array.isArray(v) ? v.map(maskTrace)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskTrace(x)])) : v;

/** One JSON line per event, one file per session (traces/<sessionId>.jsonl). Personal data is masked unless mask: false. */
export function jsonl(opts: { dir?: string; mask?: boolean } = {}): TraceSink {
  const dir = opts.dir ?? "traces", file = (id: string) => join(dir, `${basename(id)}.jsonl`);   // basename: an id is never a path
  let ready = false;
  return {
    mask: opts.mask,
    write(line) {
      if (!ready) { mkdirSync(dir, { recursive: true }); ready = true; }
      appendFileSync(file(String(line.sessionId)), JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n");
    },
    forget: (sessionId) => rmSync(file(sessionId), { force: true }),
  };
}
