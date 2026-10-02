# trust-layer-agent: API design (v0.1 draft)

The model chooses the words; code decides what's allowed. This page defines the public API and becomes the seed of SPEC.md. Signatures are TypeScript; every example also runs as plain ES-module JavaScript.

## 1. Tools

A tool is a plain async function plus a declaration. The name is always explicit (never taken from the function's name, which minifiers and refactors change).

```ts
read(def: ToolDef) / write(def: ToolDef): Tool

interface ToolDef<I, O> {
  name: string;                       // snake_case, unique, what the model and traces see
  description: string;                // for the model
  input: ZodType<I>;                  // validated before run(); invalid input goes back to the model as an error
  visible?: string[];                 // returned fields the model may see: "plan.name", "invoices[].amount"
  bind?: Record<string, string>;      // input fields filled from session facts, hidden from the model: { accountId: "facts.accountId" }
  confirm?: false | { commitment: string; by: string };  // writes only, see yes_after_quote
  beforeVerification?: boolean;       // tool may run before facts.verified (e.g. verify_customer, list_public_plans)
  verifies?: boolean;                 // this tool's records may set facts.verified (turns verified_first on)
  output?: ZodType<O>;                // optional; checked in test against stand-in output
  records?: (output: O, input: I) => {          // what a successful call writes to the session
    facts?: Record<string, Json>;                // e.g. { verified: true, accountId: output.id }
    commitments?: { type: string; id: string; values: Record<string, Json>; expiresAt?: string }[];
  };
  run(input: I, ctx: ToolContext): Promise<O>;
}

interface ToolContext {                 // read-only; tools never mutate the session directly
  facts: Readonly<Record<string, Json>>;
  commitments: readonly Commitment[];
}
```

```js
import { read, write, z, ToolError } from "trust-layer-agent";

export const quotePlanChange = read({
  name: "quote_plan_change",
  description: "Price a switch to another plan. Returns a quote the customer must accept.",
  input: z.object({ accountId: z.string(), planId: z.string(), discountCode: z.string().optional() }),
  bind: { accountId: "facts.accountId" },
  visible: ["quoteId", "planName", "monthlyPrice", "proratedCharge", "monthlySavings", "effectiveDate"],  // every number the agent may say
  records: (q) => ({ commitments: [{ type: "quote", id: q.quoteId,
    values: { monthlyPrice: q.monthlyPrice, proratedCharge: q.proratedCharge }, expiresAt: q.expiresAt }] }),
  run: (input) => billing.quote(input),                   // the app's existing function, unchanged
});
```

- **Visibility.** The model sees only `visible` fields. Everything else stays in code. Claim checks match against what the model was shown. If `visible` is omitted, fields whose names or values look like personal data (email, phone, address, dob/date of birth, ssn, card numbers) are hidden and everything else is visible; the Agent constructor lists the hidden fields per tool. `strictVisibility: true` hides every field not listed.
- **Bind.** Bound fields are removed from the input schema the model sees and filled from session facts before `run`. The model never handles them; if the fact is missing, the call is blocked. Ownership of sub-entities (say, an invoice id under the bound account) is the tool's job: `throw new ToolError("not_found", "No such invoice on this account.")`.
- **Numbers.** Tools return every number the agent may say. Here `monthlySavings` is computed in code, so the agent never does arithmetic.
- **Facts and commitments.** They're declared with `records`, not written inside `run`. They're applied only if `run` resolves, so a call that throws records nothing. Because recording is declared on the tool, a simulation stand-in (section 2) can't skip it.
- **Errors.** `throw new ToolError(code, messageForModel)` sends a structured error to the model, counts as a failure, and gives journeys a `code` to hand off on. Any other thrown error is reported as `internal_error`.
- **zod.** `z` is re-exported, so plain-JS apps don't need a second copy of zod.

## 2. Tool data source in simulation

The problem: in the app, tools call Postgres. In `test`, they must run against a seeded in-memory dataset.

- **(a) Data context.** Every tool reads data from `ctx.data`, and `test` swaps in the seed.
- **(b) Stand-ins.** The simulation suite supplies a replacement `run` for each tool, by name.

**Recommendation: (b), tightened.** A stand-in supplies *only* a `run` function: `(input, ctx, data) => result`. The name, description, input schema, read/write marker, `bind`, `confirm`, `verifies`, `visible` and `records` are all taken from the real tool, so a stand-in can't change what the model sees or what checks enforce.

`test` fails loudly if any of these is true:
- a real tool has no stand-in;
- a stand-in names a tool that doesn't exist;
- a stand-in's output fails the real tool's optional `output` schema.

Trade-off: (b) lets an app wrap its existing data functions unchanged. That's the acceptance test, and (a) would force a refactor behind an injectable data layer. The price is that the stand-in's logic can drift from the real function and `test` won't notice. We limit that by taking every declaration from the real tool, and by recommending an `output` schema on each tool so drift in what the tool returns fails `test`.

```js
// sim/suite.js
export const standIns = {
  quote_plan_change: (input, ctx, data) => data.quote(input),   // data = seeded in-memory dataset
  change_plan:       (input, ctx, data) => data.changePlan(input),
};
```

## 3. Checks

One signature guards actions (before a tool runs) and replies (before they're sent).

```ts
type Check = { name: string; run(e: CheckEvent, ctx: CheckContext): CheckResult | Promise<CheckResult> };
type CheckEvent =
  | { kind: "action"; tool: ToolInfo; input: unknown }        // ToolInfo: name, marker, bind, confirm
  | { kind: "reply"; text: string };
interface CheckContext {
  facts; commitments;
  results: ToolResult[];      // this session: tool, input, visible output, ok/error, turn
  messages: Message[];        // conversation so far; last is the customer's
}
type CheckResult =
  | { allow: true }
  | { block: string }         // a reason the model can act on
  | { rewrite: string }       // replies only; returning it for an action fails loudly
  | { handoff: string };      // summary for the person taking over

// helpers
allow(); block(reason); rewrite(text); handoff(summary);
check(name, fn): Check;
```

```js
const noRefundsOver100 = check("no_refunds_over_100", (e) =>
  e.kind === "action" && e.tool.name === "refund_invoice" && e.input.amount > 100
    ? handoff("Refund over $100 requested") : allow());

new Agent({ ..., checks: [noRefundsOver100] });
```

**Order:** built-ins run first, then journey guardrails, then custom checks in array order.
- **Actions:** the first non-allow result wins.
- **Replies:** a `rewrite` replaces the text and later checks see the new text. `block` or `handoff` stops the chain.

**Built-ins** (all on by default; disable one with `builtins: { name: false }`):
- **verified_first.** Blocks any tool not marked `beforeVerification` until `facts.verified === true`. It applies only when verification is possible: some tool declares `verifies: true`, or the session was created with `createSession({ facts: { verified } })`. Otherwise the check is off, and the Agent constructor prints a loud warning: `verified_first is OFF: no tool declares verifies: true. Account tools will run for unverified customers.`
- **yes_after_quote.** For writes, the customer's latest message must be an affirmative after the agent's last reply. Affirmatives come from a phrase list, with negations rejected. Set `confirm: false` to skip this, e.g. for open_case. If a write declares `confirm: { commitment: "quote", by: "quoteId" }`, the quote named in its input must also exist this session, have been shown in a reply, not have expired, and have been followed by that yes.
- **no_unconfirmed_claims.** Deterministic extraction from the draft reply:
  - **Money:** `$19.99`, `19.99 USD`, `€5`, `20 dollars`.
  - **Percentages.**
  - **Dates:** absolute dates and month-day forms. Relative words like "tomorrow" count as date claims.
  - **"Done" language:** a phrase list, e.g. "has been processed", "I've cancelled", "you're all set", "switched".

  Numbers are normalized before matching: commas, currency signs and trailing zeros are stripped, so `$1,019.90` matches `1019.9`. Dates are normalized to ISO.

  **A value counts as confirmed if it appears in:**
  - a visible tool result or a commitment from this session;
  - operator-authored text: the agent's instructions, journey files or knowledge docs.

  Customer text never counts.

  **Derived values aren't allowed in v0.1.** Sums, differences and "you'll save $10" aren't computed or accepted. Design rule: tools return every number the agent may say (e.g. `quote_plan_change` returns `monthlySavings`).

  **"Done" language** needs a successful write this session, and is blocked while any write has an unresolved failure (a failed call with no later success of that same tool), even if other writes succeeded.

  The block reason names the offending value, e.g. *"Reply states 18.99 but no tool returned 18.99. Use a returned value or don't state a price."*
- **untrusted_text_is_data.** Two parts:
  - **Structural:** customer text and tool output reach the model only as fenced data in user and tool turns (`<customer_message>…</customer_message>`, `<tool_result>…</tool_result>`), never in the system prompt. Angle brackets inside a fence are escaped, so the text can't close its fence or forge a `<system_note>`. Trust-layer notes (retry and blocked-action reasons) sit outside the fences, where only code can put them, and the system prompt says so.
  - **Injection, not detection:** `bind` fields (say `accountId`) are filled from session facts and never shown to the model. No text, from the customer or from a tool, can point a call at another account. Design rule: writes take ids of commitments (`quoteId`), never raw prices.
- **handoff_after_failures.** After N consecutive failures (default 2), returns `handoff` with a generated summary. Failures are failed tools or replies still blocked after retries.

**Optional and off by default:** `review({ model, rubric })` is a small-model reply check. Safety guarantees never depend on it.

## 4. Session

The session is plain JSON. The app stores it, e.g. in a Postgres `jsonb` column; the library never stores anything itself.

```json
{
  "v": 1, "id": "s_9f2c", "rev": 7, "status": "open",
  "facts": { "verified": true, "accountId": "acc_123" },
  "commitments": [
    { "type": "quote", "id": "q_789", "by": "quote_plan_change", "values": { "monthlyPrice": 29, "proratedCharge": 4.12 },
      "turn": 3, "shownTurn": 3, "acceptedTurn": 4, "status": "used", "expiresAt": "2026-10-03T00:00:00Z" }
  ],
  "results": [ { "id": "c_12", "tool": "quote_plan_change", "turn": 3, "ok": true, "output": { "...": "visible fields only" } } ],
  "messages": [ { "role": "customer", "text": "...", "turn": 1 }, { "role": "agent", "text": "...", "turn": 1 } ],
  "failures": 0
}
```

- **`status`:** `open`, `handed_off` or `closed`.
- **`rev`:** increases on every `respond()`, so the app can do optimistic locking.
- **`messages` and `results`:** the model's need-to-know view, used as context on the next turn.
- **Logs:** the full masked trace goes to the trace sink (section 8), not into the session.
- **Starting a session:** `createSession({ facts })` lets an app that already authenticated the user start with `verified: true` and an `accountId`. Facts set by app code are trusted.
- **Deleting:** `forget(session)` returns `{ v: 1, id, forgotten: true }`; the app overwrites or deletes its row.

## 5. Model interface

```ts
interface Model {
  id: string;                                         // "anthropic:<model>", recorded in traces and snapshots
  generate(req: ModelRequest): Promise<ModelResponse>;
}
interface ModelRequest  { system: string; messages: ModelMessage[]; tools: ToolSpec[]; maxTokens?: number }
type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };
interface ToolSpec      { name: string; description: string; inputSchema: JsonSchema }   // generated from zod
interface ToolCall      { id: string; name: string; input: unknown }
interface ModelResponse { text: string; toolCalls: ToolCall[]; stop: "end" | "tool_calls" | "max_tokens" | "refusal";
                          usage?: { inputTokens: number; outputTokens: number } }
```

- **What an adapter does:** translates this internal format to and from one provider's HTTP API using `fetch`, and maps the provider's stop reasons, including refusals.
- **Errors:** a network or 5xx failure after retries throws `ModelError`. `test` counts that as an infrastructure error, not a fail.
- **Options live on the adapter, not on Agent:** `anthropic({ model, apiKey?, baseUrl?, maxTokens?, extra? })` and `openaiCompatible({ model, baseUrl, apiKey?, headers?, extra? })`. Different roles (agent, reviewer, simulated customer) can point at different endpoints, and Agent stays provider-free.
- **Strings:** `"provider:model"` is shorthand. `"anthropic:<model>"` reads `ANTHROPIC_API_KEY`; `"openai-compatible:<model>"` reads `OPENAI_API_KEY` and `OPENAI_BASE_URL`.
- **Your own models:** any object with `id` and `generate()` works.

## 6. Agent API

```ts
new Agent({
  model: string | Model,
  instructions: string,
  tools: Tool[],
  checks?: Check[],
  builtins?: Partial<Record<BuiltinName, false | object>>,   // per-check options or false to disable
  journeys?: string | string[],      // YAML file(s) or a directory; validated in the constructor
  knowledge?: string | string[],     // operator-authored text/markdown files added to the prompt (e.g. FAQs)
  strictVisibility?: boolean,        // hide every tool field not listed in `visible`
  trace?: TraceSink | false,         // default: JSONL to ./traces/, masked
  maxToolCalls?: number,             // per turn, default 8
  maxRetries?: number,               // per blocked reply, default 2
  handoffMessage?: string,           // what the customer sees on handoff
});

agent.respond(session: Session | null, message: string): Promise<{ reply: string; session: Session; handoff?: { summary: string; reason: string } }>
agent.chat(opts?: { session?: Session }): Promise<void>   // terminal loop; prints blocked drafts and check results inline
```

`respond(null, …)` starts a new session. The returned session is a new object; the app saves it. There's no streaming: a reply is checked before it's sent.

When a check doesn't allow:
- **Action blocked:** the tool doesn't run. The model receives `{ blocked: reason }` as the tool result and carries on, within `maxToolCalls`.
- **Reply blocked:** the draft is discarded and never shown. The model gets the reason as a system note and drafts again, up to `maxRetries`. If it's still blocked, the turn becomes a handoff.
- **Rewrite:** the customer sees the rewritten text.
- **Handoff** (from a check, a journey condition, or a `handoff_to_person` tool): the customer sees `handoffMessage`. The response carries `handoff`, and the session `status` becomes `handed_off`. Routing to a person is the app's job.

## 7. Journeys

A journey is a YAML file with two kinds of content:
- **Prose for the prompt:** `goal`, `when`, `guidance` and `done_when` are rendered into the system prompt.
- **`guardrails`:** a list of check names, enforced in code.

Only guardrails are enforced. Guidance is a prompt.

**Guardrail entries:** each one is a check name.
- **Plain names:** a built-in (e.g. `verified_first`) or a custom check passed to the Agent.
- **Parameterized built-ins (a closed set):**
  - `require_call_before {tool, call}`
  - `allow_values {tool, input, from, field}`
  - `max_calls {tool, per_session}`
  - `require_fact {tool, fact}`
  - `handoff_when {tool_result {tool, field, equals|in} | tool_error {tool, code} | customer_says [phrases] | fact {name, equals}, summary}`
- **Loading fails** if a named check is unknown or disabled.
- **`handoff_when`** fires before the next action or reply.

**No active-journey state:** in v0.1 all loaded journeys are active at once. Guardrails are scoped by the tools they name, so there's no journey-switching state and no router.

**Validation:** at load time the YAML is parsed with positions and validated against the schema; tools, fields and facts are checked against the Agent's tools. Errors carry file and line, e.g. `journeys/plan-change.yaml:27:7 guardrails[3].tool: unknown tool "change_plann" (did you mean "change_plan"?)`. The JSON Schema is generated from the zod schema and published in SPEC.md.

```yaml
# journeys/plan-change.yaml
id: plan-change
goal: Help a verified customer find the plan that fits their usage, and switch only after they accept a quote.
when: The customer asks about changing, upgrading or downgrading their plan, running out of usage, or their price.
guidance:
  - Verify the customer with verify_customer before discussing their account.
  - Look up the account and usage with get_account and get_usage.
  - Follow get_usage's suggestion. "upgrade" means they hit the limit in 2 of the last 3 cycles; recommend an upgrade. "usage_pack" means once; offer a one-time usage pack. "none" means ask what they need.
  - Offer only plans returned by get_eligible_plans.
  - Quote the chosen plan with quote_plan_change. State the new monthly price, the one-time prorated charge and the effective date exactly as returned.
  - Ask for a clear yes, then call change_plan with the quote_id.
  - If change_plan fails, say plainly that it did not go through, open a case with open_case and give the case id.
done_when:
  - change_plan succeeded and the customer was told the new price and effective date.
  - add_usage_pack succeeded.
  - The customer chose to keep their plan.
  - A case was opened, or the customer was handed off.
guardrails:
  - verified_first
  - yes_after_quote
  - no_unconfirmed_claims
  - require_call_before: { tool: change_plan, call: quote_plan_change }
  - allow_values: { tool: quote_plan_change, input: planId, from: get_eligible_plans, field: "plans[].id" }
  - allow_values: { tool: quote_plan_change, input: discountCode, from: get_account, field: "approvedDiscounts[].code" }
  - max_calls: { tool: add_usage_pack, per_session: 1 }
  - handoff_when:
      tool_result: { tool: get_account, field: plan.pricing, in: [custom, enterprise] }
      summary: Account has custom or enterprise pricing.
  - handoff_when:
      customer_says: ["real person", "human", "representative", "manager", "speak to someone"]
      summary: Customer asked for a person.
```

Design note: the "2 of the last 3 cycles" rule is computed in code inside `get_usage` (it returns `suggestion`). Decisions go in tools and the words go to the model. Writing "open a case" in guidance is a request to the model; the guarantee that a failed change is never reported as done comes from the `no_unconfirmed_claims` guardrail.

## 8. Traces

The trace is one JSON line per event:
- `turn`: customer message, final reply, retries, model id, usage.
- `tool`: name, input, visible output, ok/error code, duration.
- `check`: event kind, check name, result.

Every line has `ts`, `sessionId`, `turn` and `snapshot`.

**Masking (on by default):**
- **What's masked:** emails, phone numbers (international and common national formats) and street addresses (house number + street-suffix pattern), each replaced by `[email]`, `[phone]` or `[address]`.
- **Where:** in all text and in tool inputs and outputs.
- **Turning it off:** `trace: jsonl({ dir, mask: false })`.

Masking is best-effort pattern matching. The real guarantee is field visibility: data the model never sees never reaches the model-side trace.

## 9. Simulation tasks

```yaml
# sim/tasks/quote-before-yes.yaml
id: quote-before-yes
purpose: Customer says "yes, switch me" before any quote exists. The agent must quote first.
customer:
  persona: Busy, terse.
  reason_for_call: You want the Plus plan.
  known_info: You are Dana Ruiz, account acc_204, PIN 4417.
  unknown_info: You don't know Plus's price.
  instructions: Your first message is "Switch me to Plus, yes, do it." Accept if the monthly price is under $30.
seed: { accounts.acc_204.plan.id: basic }          # patches to the suite seed
inject_failures: []                                 # e.g. [{ tool: change_plan, code: billing_unavailable }]
expect:
  actions: [ { tool: change_plan, input: { accountId: acc_204 }, compare: [accountId] } ]
  forbidden_actions: [ add_usage_pack ]
  required_claims: [ { kind: price, value: 29 }, { kind: price, value: 4.12 } ]
  must_handoff: false
k: 4                                                # optional per-task override
```

**Grading:** a trial passes only if every part passes.
- **Final data state:** two copies of the seed. Apply the expected actions to one through the stand-ins; the other is the dataset after the live run. Compare as canonical JSON (sorted keys, numbers normalized). Reads are ignored.
- **Expected writes:** each appears with matching `compare` arguments.
- **Forbidden actions:** none was *executed*. Blocked attempts are reported but don't fail.
- **Required claims:** each appears in a sent reply after number normalization.
- **Claim checks:** the built-in claim checks are re-run on every sent reply, even if they were disabled at runtime.
- **Handoff:** whether a handoff happened matches `must_handoff`.

There's no LLM judge.

**How a run ends:**
- The simulated customer emits `###STOP###`, `###TRANSFER###` or `###OUT-OF-SCOPE###`.
- A handoff happens.
- The run hits `maxTurns` (default 30), which is a fail.
- A `ModelError` gives an infrastructure error, which isn't scored.

**Before scoring,** `test` validates every task:
- the schema, with file and line;
- every tool named exists;
- stand-ins cover every real tool;
- the expected actions run on a copy of the seed without error;
- every expected write changes state.

Any failure exits with code 2 before a single model call. Wrong expected answers in test cases are the most common grading bug, so the test cases get tested too.

## 10. Commands

`npx trust-layer-agent test [--k 4] [--tasks a,b] [--customer-model anthropic:<model>] [--concurrency 2]`
- **Suite:** loads `trust-layer.config.js`, which exports `{ agent, seed, standIns, tasks: "sim/tasks", customerModel, k }`.
- **Prints:** per-task pass^k, overall pass^k, infrastructure errors listed separately, cost, and a diff against the newest snapshot (newly failing, newly passing, change in pass^k).
- **Writes:** `results/<timestamp>.jsonl`.
- **Exit codes:** non-zero if pass^k dropped.

`npx trust-layer-agent snapshot --name v2`
- **Writes** `snapshots/v2.json` (committed to git). It pins:
  - model ids for the agent, the reviewer and the simulated customer;
  - instructions;
  - journey contents;
  - tool specs (name, description, input JSON Schema, marker, visibility, bind, confirm);
  - check names and options;
  - the package version;
  - the latest results.
- **Refuses** if no results exist for the current configuration hash. You can't snapshot what you haven't tested.

## 11. Package layout (target lines)

| File | Lines | | File | Lines |
|---|---|---|---|---|
| src/index.ts | 15 | | src/models/types.ts | 30 |
| src/tools.ts | 70 | | src/models/anthropic.ts | 60 |
| src/checks.ts | 45 | | src/models/openai-compatible.ts | 60 |
| src/builtins.ts | 80 | | src/models/resolve.ts | 15 |
| src/claims.ts (extract + normalize, shared with grader) | 90 | | src/trace.ts | 40 |
| src/session.ts | 45 | | src/sim/task.ts | 40 |
| src/agent.ts | 140 | | src/sim/simulator.ts | 90 |
| src/chat.ts | 25 | | src/sim/grade.ts | 60 |
| src/journeys.ts | 90 | | src/sim/validate.ts | 35 |
| | | | src/cli.ts | 60 |

Total ≈ 1,090. The core (left column, models and trace) is ≈ 805; the simulator and CLI are ≈ 285. Tests aren't counted.

## 12. Acceptance check: plain-JS Express + Postgres

```js
// routes/support.js  (plain ESM, no build step)
import { createSession } from "trust-layer-agent";
import { agent } from "../agent.js";               // tools wrap the app's existing data functions
import { pool } from "../db.js";

export async function supportRoute(req, res) {
  const id = req.params.conversationId;
  const { rows } = await pool.query("select data from agent_sessions where id = $1", [id]);
  const session = rows[0]?.data ?? createSession({ facts: { verified: true, accountId: req.user.accountId } });
  const { reply, session: next, handoff } = await agent.respond(session, req.body.message);
  await pool.query(
    `insert into agent_sessions (id, data) values ($1, $2)
     on conflict (id) do update set data = excluded.data, updated_at = now()`, [id, next]);
  if (handoff) await notifySupport(id, handoff.summary);
  res.json({ reply, handedOff: Boolean(handoff) });
}
```

Writing this sketch changed the design in one place. A logged-in app already knows who the customer is, so `createSession({ facts })` was added (section 4): chat-based verification is only for anonymous channels. No core change is needed for the four target journeys (which plan fits, where's my request, general product questions, "I'm in danger"): each is tools + journey YAML + simulation tasks, and "I'm in danger" is a `handoff_when: { customer_says: [...] }` guardrail.

## 13. Decisions (formerly open questions)

1. **Default visibility.** If `visible` is omitted, fields that look like personal data (by name or by value: email, phone, address, dob/date of birth, ssn, card numbers) are hidden and everything else is visible. The constructor lists the hidden fields per tool. `strictVisibility: true` hides every field not listed.
2. **Customer-stated numbers.** They never count as confirmed. Only tool results, commitments and operator-authored text do. The block reason tells the model to rephrase.
3. **Affirmations.** An English phrase list in v0.1, configurable via `builtins: { yes_after_quote: { phrases } }`.
4. **The session holds `messages` and `results`,** the need-to-know context. The masked trace goes to a sink, not the session.
5. **Quickstart** uses the `read({ name, … })` object form and `model: openaiCompatible({ … })`.
6. **The example includes `verify_customer`** (read, `beforeVerification: true`, `verifies: true`).
7. **Concurrent messages.** The app does compare-and-set on `session.rev`; the library increments it.
8. **Stand-ins** are per suite, with per-task `inject_failures`.
9. **Line budget** is ≈1,090. Task validation stays.
10. **Relative dates** ("tomorrow") are date claims and need a tool-returned date this session.
