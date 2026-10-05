# Prompt: add trust-layer-agent to my app

trust-layer-agent is a small trust layer for customer-facing agents: tools gated by checks in code, replies that can't claim what no tool confirmed, customer data shown to the model only on a need-to-know basis, and releases that must pass simulations first.

This prompt has your coding agent add a support agent to an existing JavaScript or TypeScript app. It wraps your data functions as tools, adds one chat route that stores the session in your database, then writes a journey file and five simulation tasks and runs them. It stops after each step for your OK. Only step 8 costs money, because it calls a model; it shows an estimate first and stops at a cost limit.

Copy everything inside the block into your coding agent, from the app's root folder.

````text
Add trust-layer-agent to this app. The model chooses the words; code decides what's allowed. You write three
things (tools, checks, journeys), call one function (agent.respond) and run two commands (test, snapshot).
Extend only through tools, checks, journeys and model adapters; never patch the package. It ships as plain ESM
JavaScript with types: no build step in plain-JS apps, types for free in TS. Use only names the installed
package exports (node_modules/trust-layer-agent/dist/index.d.ts): Agent, read, write, z, ToolError, check,
allow, block, rewrite, handoff, createSession, forget, jsonl, maskTrace, anthropic, openaiCompatible, ModelError.
If this prompt disagrees with those type files, the type files win; tell me. At every STOP, show me your work
and wait.

STEP 1: Inspect the data layer, routes, auth and database. Show one row per candidate tool:
| tool (snake_case) | read/write | function it wraps (file:line) | bind | visible | confirm | records | outcome |
- bind: input fields filled from session facts, never by the model: { accountId: "facts.accountId" }. Every
  identity or ownership field goes here.
- visible: only the returned fields the model needs ("plan.name", "invoices[].amount"). Every number the agent
  may say must be visible; derived numbers (savings, totals) are computed in code.
- confirm (writes): { commitment: "quote", by: "quoteId" } for anything priced (the write takes a quote id,
  never a price); false for writes that need no yes (open a case, hand off); omit otherwise.
- records: facts or commitments a successful call adds to the session (e.g. a quote).
- outcome (writes): "done", or can it be pending / time out after applying? Then name the read that shows the truth.
Also say how customers are identified (logged in, or anonymous and verified in chat), which decisions already
live in code (eligibility, prices, refund windows), and how a person takes over. STOP.

STEP 2: `npm install github:OWNER/trust-layer-agent` (Node 20+). It's not on npm yet; its prepare script builds
it on install. Put the key in a gitignored .env: ANTHROPIC_API_KEY for model "anthropic:<model-name>", or
OPENAI_API_KEY and OPENAI_BASE_URL for "openai-compatible:<model-name>".

STEP 3: Tools in agent/tools.js (tools.ts in TS; zod infers input types). Export a factory over the data
functions, so simulations can pass a seeded copy and importing tools never opens a database connection:

  import { read, write, z, ToolError } from "trust-layer-agent";
  const bind = { accountId: "facts.accountId" };
  export const makeTools = (data) => [
    read({ name: "quote_plan_change", description: "Price a plan switch. Show it and get a yes before change_plan.",
      input: z.object({ accountId: z.string(), planId: z.string() }), bind,
      visible: ["quoteId", "planName", "monthlyPrice", "proratedCharge", "effectiveDate", "expiresAt"],
      records: (q) => ({ commitments: [{ type: "quote", id: q.quoteId, expiresAt: q.expiresAt,
        values: { monthlyPrice: q.monthlyPrice, proratedCharge: q.proratedCharge } }] }),
      run: ({ accountId, planId }) => data.quotePlanChange(accountId, planId) }),
    write({ name: "change_plan", description: "Apply a quote the customer accepted.",
      input: z.object({ accountId: z.string(), quoteId: z.string() }), bind, confirm: { commitment: "quote", by: "quoteId" },
      outcome: (o) => (o.status === "pending" ? "pending" : "done"), reconcileWith: "get_account",
      run: async ({ accountId, quoteId }) => {
        let changed;
        try { changed = await data.changePlan(accountId, quoteId); }
        catch (e) { if (e.name !== "TimeoutError") throw e;      // however your client signals a timeout
          throw new ToolError("timeout", "No response; it may have applied.", { outcome: "unknown" }); }
        if (!changed) throw new ToolError("change_failed", "The plan was not changed.");
        return changed;
      } }),
  ];

Wrap existing functions unchanged. Throw ToolError(code, message) for expected failures; other errors reach the
model only as "internal_error". A tool taking a sub-entity id (an invoice) checks it belongs to the bound
account and throws ToolError("not_found", ...). Add a write named handoff_to_person (input { summary },
beforeVerification: true, confirm: false): a successful call ends the turn as a handoff. For chat verification,
add a read with beforeVerification: true, verifies: true and
records: (o) => (o.verified ? { facts: { verified: true, accountId: o.accountId } } : {}).

Declare write outcomes for writes that can time out or be pending (get_account above is a read, not shown):
- outcome: (output) => "done" | "pending" (default "done"). The agent may not call a pending write done.
- ToolError(code, message, { outcome: "unknown" }) for a write that may have happened (a timeout after the
  request was sent). A plain ToolError means it didn't happen.
- reconcileWith: "<read tool>" names the read that shows the true state. While an outcome is unknown, no reply
  may say it worked or failed until that read runs; without reconcileWith the agent can only say it's checking.
- repeatable: true only for a write that may legitimately succeed twice in one turn (two separate refunds,
  say). Otherwise no_repeated_writes blocks a second call once the first succeeded.

STEP 4: agent/agent.js. Export the config separately; the simulator reuses it unchanged:

  import { Agent } from "trust-layer-agent";
  import { makeTools } from "./tools.js";
  import * as data from "../db/queries.js";                 // the app's real data functions
  export const agentConfig = { instructions: "You help customers with their plan and billing. Reply in plain text." };
  // later: journeys (file, directory or list), knowledge (.md/.txt policy text), checks: [custom checks]
  export const agent = new Agent({ ...agentConfig, model: "anthropic:<model-name>", tools: makeTools(data) });

Six built-in checks are on by default: verified_first, yes_after_quote, no_unconfirmed_claims (prices, dates,
"done" wording, and "it failed" wording after a write that succeeded), handoff_after_failures
(builtins: { handoff_after_failures: { after: 3 } } tunes it), no_repeated_writes and untrusted_text_is_data
(structural, always on). A custom check is one function:
  check("big_refunds_to_person", (e) => e.kind === "action" && e.tool.name === "refund_invoice" &&
    e.input.amount > 100 ? handoff("Refund over $100 requested.") : allow())
Traces go to ./traces/<sessionId>.jsonl (trace: false turns them off). Every sink receives lines with emails,
phones, cards, SSNs and addresses already masked; only a sink that sets mask: false gets them raw. A custom sink
(e.g. a Postgres table) is { write(line), forget(sessionId) }: implement forget so deleting a conversation
deletes its trace lines too. Show me the startup warnings ("verified_first is OFF" is expected if every session
starts verified by your login; sessions you create with facts: { verified } are still checked). STOP.

STEP 5: One table and one Express route:

  create table agent_sessions (id text primary key, account_id text not null, rev integer not null,
    data jsonb not null, updated_at timestamptz not null default now());

  import { createSession, ModelError } from "trust-layer-agent";
  router.post("/support/messages", async (req, res) => {
    const { sessionId, message } = req.body, accountId = req.user.accountId;    // from auth, never the body
    let session;
    if (sessionId) {
      const { rows } = await pool.query("select data from agent_sessions where id = $1 and account_id = $2", [sessionId, accountId]);
      if (!rows[0]) return res.status(404).end();
      session = rows[0].data;
    } else {
      session = createSession({ facts: { verified: true, accountId } });
      await pool.query("insert into agent_sessions (id, account_id, rev, data) values ($1, $2, $3, $4)", [session.id, accountId, session.rev, session]);
    }
    let r;
    try { r = await agent.respond(session, message); }                       // { reply, session, handoff?, usage }
    catch (e) { if (e instanceof ModelError) return res.status(503).json({ error: "Try again shortly." }); throw e; }
    const saved = await pool.query("update agent_sessions set data = $1, rev = $2, updated_at = now() where id = $3 and rev = $4",
      [r.session, r.session.rev, r.session.id, session.rev]);
    if (!saved.rowCount) return res.status(409).json({ error: "This conversation changed elsewhere. Reload." });
    if (r.handoff) await notifySupport(r.session.id, r.handoff.summary, r.handoff.reason);   // your own routing
    res.json({ sessionId: r.session.id, reply: r.reply, handedOff: Boolean(r.handoff) });
  });

respond() never mutates the session you pass and bumps rev each turn, so the update is a compare-and-set. Tools
may have run before a save loses, so also handle one message at a time per conversation. Anonymous visitors get
createSession({ facts: { verified: false } }) and the verify tool. A handed-off session only returns the handoff
message; start a new one to talk to the agent again. To delete a conversation, call agent.forget(session): it
deletes the trace through the sink's forget (warning once if your sink has none) and returns the
{ v, id, forgotten } tombstone; overwrite the row with it, or delete the row. STOP.

STEP 6: One journey in agent/journeys/<id>.yaml; add it to agentConfig.journeys (an absolute path built from
import.meta.url; relative paths resolve from the working directory). Fields: id (lowercase-with-dashes), goal,
when?, guidance (list; a prompt), done_when? (list), guardrails (list; enforced in code). A guardrail is a check
name or one of: require_call_before {tool, call}; allow_values {tool, input, from, field}; max_calls {tool,
per_session}; require_fact {tool, fact}; handoff_when {one of tool_result {tool, field, equals | in},
tool_error {tool, code}, customer_says [phrases], fact {name, equals}; plus summary}. Mistakes fail at startup
with file:line.

  id: plan-change
  goal: Help a customer pick a plan that fits, and switch only after they accept a quote.
  when: The customer asks about changing plans, running out of usage, or their price.
  guidance:
    - Quote with quote_plan_change, state the price exactly as returned, then ask for a clear yes.
    - If change_plan fails, say plainly that it did not go through and offer a person.
  guardrails:
    - require_call_before: { tool: change_plan, call: quote_plan_change }
    - handoff_when: { customer_says: ["real person", "human", "speak to someone"], summary: Customer asked for a person. }

STOP.

STEP 7: Simulations in agent/sim/. seed.js exports SEED and createStore(seed, { now }): an in-memory clone of the
seed whose methods mirror the data functions the tools wrap. Never use the production database. Write 5 tasks
in agent/sim/tasks/: happy path; "yes, do it" before any quote; a failed write (inject_failures); another
account or a prompt injection (forbidden_actions); asks for a person (must_handoff: true). Format (optional:
unknown_info, initial_state, inject_failures, max_steps, each key inside expect):

  id: happy-path
  purpose: What this task proves.
  customer: { persona: ..., reason_for_call: ..., known_info: ..., unknown_info: ..., instructions: ... }
  initial_state: { "accounts.acc_1.plan": starter }               # dot-path patches to the seed
  inject_failures: [ { tool: change_plan, code: billing_unavailable, message: Nothing was changed. } ]
  expect:
    writes: [ { tool: change_plan, input: { accountId: acc_1, quoteId: q_001 }, compare: [accountId] } ]
    allowed_writes: [ open_case ]                  # extra writes that are fine; replayed into the expected state
    forbidden_actions: [ refund_invoice ]          # must never execute; blocked attempts are fine
    must_handoff: false
    required_claims: [ { kind: price, value: 29 } ]   # price | percent | date
    forbidden_claims: [ { money: 0 } ]               # or { percent: 50 }
    allow_in_refusal: false                          # true: "I can't offer Plus at $10" doesn't count as saying $10
    must_not_claim_done: false                       # true: no reply may say it happened (pending or failed writes)
    forbidden_phrases: [ "full refund" ]             # asserted uses fail; "the full refund didn't go through" is fine
  max_steps: 12                                      # customer turns (default 20); reaching it fails

expect.writes replay in order on a fresh seed through the stand-ins to build the expected state (list a read
too if a later write needs what it creates, like quote q_001; add allow_error: <code> to a step that may end
in that ToolError, like a write that applies and then times out). A trial passes only if the final state
matches, expected writes ran with matching compare fields, no forbidden action ran, the handoff matches,
required claims were said, nothing forbidden was asserted, and no reply stated a price, date or "done" that no
tool had returned by the time that reply was sent. suite.js (plain JS even in TS apps: import your build output,
or run the CLI under a TypeScript loader):

  import { fileURLToPath } from "node:url";
  import { agentConfig } from "../agent.js";
  import { makeTools } from "../tools.js";
  import { SEED, createStore } from "./seed.js";
  export default {
    agent: agentConfig, tools: makeTools({}),    // declarations only: standIns replace every run, so no store here
    standIns: { quote_plan_change: ({ accountId, planId }, _ctx, store) => store.quotePlanChange(accountId, planId) },  // one per tool
    seed: SEED, createStore,                                       // createStore may be async
    state: (store) => ({ /* what the grader compares; no generated ids */ }),   // may be async
    tasks: fileURLToPath(new URL("./tasks", import.meta.url)),
    agentModel: "anthropic:<model-name>", customerModel: "anthropic:<model-name>",    // pinned per run
    prices: { "anthropic:<model-name>": { input: 0, output: 0 } },    // USD per million tokens: fill in
    now: "2026-01-15T12:00:00Z",                                       // optional fixed clock
  };

Prefer the in-memory store. If your data functions only work against Postgres, createStore and state() may both
be async: createStore can create and seed a throwaway schema (one per call, since the live and expected stores
need separate schemas) and return a handle to it, and state() queries it. Never production. STOP.

STEP 8: Run from the app root (it reads .env and writes results/ and snapshots/ there). This costs real money:
the agent and the simulated customer both call the model. It prints an estimate first (from the last run's
tokens at the current prices) and stops once spend passes --max-cost (default 10).
  npx trust-layer-agent test --suite agent/sim --k 1 --tasks happy-path --max-cost 1
  npx trust-layer-agent test --suite agent/sim --k 4 --max-cost 5
Report per task: trial marks (P pass, F fail, I infrastructure, - stopped), pass^4 with the trial count behind
it (e.g. "3/4 trials passed, so pass^4 fails"), pass^1 and friction (blocked actions and drafts per trial).
Then the overall pass^4 with how many tasks passed out of how many. With 5 tasks, one flaky task moves it by 20
points, so always quote the counts. For each failure, read trials[].grade and the transcript in results/*.json
and propose a fix to tools, checks, journeys or instructions.
Exit codes: 0 the gate passed; 1 it failed ("FAILED the gate": pass^k below --min-pass, default 1 meaning every
task, or a task that passed in the snapshot now fails); 2 an error before or outside the trials (bad suite,
invalid task, missing price, unknown --against name). --min-pass 0.8 lowers the bar while you iterate; don't
lower it to call a release done. STOP.
Once I approve: `npx trust-layer-agent snapshot --suite agent/sim --name v1` (it refuses if anything changed
since the last test), then commit snapshots/v1.json. Later runs diff against the newest snapshot; pin the
baseline with `npx trust-layer-agent test --suite agent/sim --k 4 --against v1`, which fails before any model
call if v1 doesn't exist and exits 1 if any task flipped pass→fail. Use that exit code in CI.

NEVER
- Hardcode prices, plan details or dates in instructions, journeys or knowledge; they come from tools. (Operator
  text counts as confirmed for claims, so a stale price there passes the checks.)
- Let the model pass account ids or other identity fields. Use bind.
- Write before the customer's yes. Keep yes_after_quote on; use confirm with a quote commitment for anything priced.
- Let the model decide fit or eligibility in prose for a write ("Starter covers your usage"). No check reads that
  kind of claim. Return it from a tool (e.g. the quote includes fitsUsage) and gate the write on it with a check.
- Disable or loosen built-in checks to make a test pass.
- Weaken, delete or reword a simulation task to make it pass.
- Show the model fields it doesn't need.
- Run chat() or simulations against production data.
````
