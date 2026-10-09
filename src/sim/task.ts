import { z } from "zod";
import { fromZod, listFiles, readYaml, where } from "../files.js";

const str = z.string().min(1);
const record = z.record(z.string(), z.any());
const TaskFile = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be lowercase-with-dashes"),
  purpose: str,
  user: z.object({ persona: str, reason: str, known_info: str, unknown_info: str.optional(), instructions: str }).strict(),
  initial_state: record.default({}),                                     // dot paths into the seed: { "customers.acc_1.pin": "0000" }
  inject_failures: z.array(z.object({ tool: str, code: str, message: str.optional() }).strict()).default([]),
  expect: z.object({
    // allow_error: this expected step may end in that ToolError code (e.g. a write that applies, then times out)
    writes: z.array(z.object({ tool: str, input: record.default({}), compare: z.array(str).default([]), allow_error: str.optional() }).strict()).default([]),
    forbidden_actions: z.array(str).default([]),
    must_handoff: z.boolean().default(false),
    required_claims: z.array(z.object({ kind: z.enum(["price", "percent", "date"]), value: z.union([z.number(), str]) }).strict()).default([]),
    forbidden_claims: z.array(z.object({ money: z.number().optional(), percent: z.number().optional() }).strict()).default([]),
    allow_in_refusal: z.boolean().default(false),                       // forbidden values may appear inside a refusal that governs them
    must_not_claim_done: z.boolean().default(false),                    // no sent reply may say an action happened
    forbidden_phrases: z.array(str).default([]),                        // phrases no sent reply may assert (negated/conditional uses are fine)
    allowed_writes: z.array(str).default([]),                           // extra writes that are fine here; replayed into the expected state
  }).strict(),
  max_steps: z.number().int().positive().default(20),                   // user turns before the run counts as a fail
}).strict();

export type Task = z.infer<typeof TaskFile> & { file: string };

/** Load simulation tasks; invalid files throw with file:line:col. */
export function loadTasks(paths: string | string[]): Task[] {
  return listFiles(paths).map((file) => {
    const { doc, lines } = readYaml(file);
    const r = TaskFile.safeParse(doc.toJS());
    if (!r.success) throw new Error("Invalid task:\n" + fromZod(r.error).map((i) => "  " + where(file, doc, lines, i)).join("\n"));
    return { ...r.data, file };
  });
}
