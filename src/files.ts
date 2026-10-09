// Reading operator-authored files: YAML with positions, and listing files in named paths or directories.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LineCounter, parseDocument, type Document } from "yaml";
import type { z } from "zod";

export type Issue = { path: (string | number)[]; message: string; keys?: string[] };

/** "file:line:col path: message" for an issue, pointing at the offending key when the node is known. */
export function where(file: string, doc: Document, lines: LineCounter, issue: Issue): string {
  let node: any, p = issue.path;
  for (;;) { node = p.length ? doc.getIn(p, true) : doc.contents; if (node || !p.length) break; p = p.slice(0, -1); }
  const key = issue.keys && node?.items?.find((i: any) => i.key?.value === issue.keys![0])?.key;
  const pos = lines.linePos((key ?? node)?.range?.[0] ?? 0);
  const at = issue.path.map((s) => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("").replace(/^\./, "");
  return `${file}:${pos.line}:${pos.col} ${at ? at + ": " : ""}${issue.message}`;
}

export const fromZod = (e: z.ZodError, prefix: (string | number)[] = []): Issue[] => e.issues.map((i) => ({ path: [...prefix, ...(i.path as (string | number)[])],
  message: i.code === "unrecognized_keys" ? `unknown field "${i.keys[0]}"` : i.message, keys: i.code === "unrecognized_keys" ? i.keys : undefined }));

/** Parse a YAML file keeping positions; syntax errors throw with file and line. */
export function readYaml(file: string) {
  const lines = new LineCounter(), doc = parseDocument(readFileSync(file, "utf8"), { lineCounter: lines, prettyErrors: false });
  if (doc.errors.length) throw new Error(`${file}:${lines.linePos(doc.errors[0].pos[0]).line} ${doc.errors[0].message.split("\n")[0]}`);
  return { doc, lines };
}

/** Files named directly, plus matching files inside any directories named. */
export function listFiles(paths: string | string[], ext = /\.ya?ml$/): string[] {
  return [paths].flat().flatMap((p) => statSync(p).isDirectory()
    ? readdirSync(p).filter((f) => ext.test(f)).sort().map((f) => join(p, f)) : [p]);
}
