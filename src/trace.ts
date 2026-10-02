import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { maskText } from "./privacy.js";

export interface TraceSink { write(line: Record<string, unknown>): void }

const maskDeep = (v: unknown): unknown =>
  typeof v === "string" ? maskText(v)
  : Array.isArray(v) ? v.map(maskDeep)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)])) : v;

/** One JSON line per event, one file per session (traces/<sessionId>.jsonl). Personal data is masked unless mask: false. */
export function jsonl(opts: { dir?: string; mask?: boolean } = {}): TraceSink {
  const dir = opts.dir ?? "traces";
  let ready = false;
  return {
    write(line) {
      if (!ready) { mkdirSync(dir, { recursive: true }); ready = true; }
      const out = { ts: new Date().toISOString(), ...(opts.mask === false ? line : (maskDeep(line) as object)) };
      appendFileSync(join(dir, `${line.sessionId}.jsonl`), JSON.stringify(out) + "\n");
    },
  };
}
