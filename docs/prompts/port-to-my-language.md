# Prompt: port trust-layer-agent to my language

trust-layer-agent is a TypeScript library (Node 20+) that sits between an LLM and a customer-facing support agent's tools and replies. It enforces rules in code: tool calls are checked before they run, and replies are checked before they're sent. It also ships a simulator for testing agents.

SPEC.md defines the parts that don't depend on a language: the session JSON, the check result shape, the journey schema and the simulation task format. The TypeScript package is the reference implementation. This prompt has your coding agent build a port in another language, smallest piece first, using the reference tests as conformance cases. It finishes by running the same simulation suite the reference passes and comparing the scores. It stops for your OK after the plan and after the check tables pass. Only the last step costs money.

Replace `<language>` and `<repo-url>`, then copy everything inside the block into your coding agent.

````text
Port trust-layer-agent to <language>. Reference repo: <repo-url>. Clone it and read SPEC.md, then src/ (about
1,500 lines of TypeScript), test/ and examples/subscriptions/. SPEC.md is the contract. Where SPEC.md, the
source and the tests disagree, the source and its tests win; list every disagreement for me.

Keep the design intact: three things a user writes (tools, checks, journeys), one call (respond), two commands
(test, snapshot), four extension points (tools, checks, journeys, model adapters). Don't add features. Put ideas in a list for me instead.

RULES
- Dependencies: a schema validator that can emit JSON Schema, and a YAML parser that keeps line numbers. Use
  the standard library for HTTP, JSON, UUIDs, hashing and files. No model provider SDKs and no agent framework.
- Same wire formats, byte for byte where it matters: session JSON (v, id, rev, status, facts, commitments,
  results with each write's outcome, messages, failures), check results ({allow: true} | {block} | {rewrite} |
  {handoff}), journey and task YAML, trace lines, results/ and snapshots/ JSON. A session saved by the TypeScript package must load in
  the port and the other way round.
- Checks are deterministic code. Copy phrase lists, regexes, block reasons and notes exactly (SPEC.md requires
  the exact strings), then fix regex-dialect differences until the reference tables pass: \b is the ASCII word
  boundary, and lookbehind and case folding vary by language. Round money to the cent the way
  the reference does (Math.round(x * 100) / 100, which rounds halves up). Many languages round halves to even.
- Port each reference test file as conformance cases: same rows, same expected outcomes. Keep the rows marked
  as known false positives; they document behavior. Never change an expected outcome to make a port pass.
- Every relaxation in the claim and consent rules comes with attack rows: the refusal allowance, negated
  subjects ("nothing has been changed"), status phrases ("all set staying on Starter"), the extra consent
  phrases, the bare "you're all set" pleasantry, the write-outcome states, no_repeated_writes' repeatable
  opt-out, and the grader's refusal and assertion matchers. The attack rows must pass too. A port that lets the
  allowed rows through but also lets an attack through is wrong, however good its simulation score.
- Idiomatic names are fine (createSession may become create_session). Behavior and JSON stay the same.

STEP 0: Plan. Show me the module list in build order, the two dependencies you chose and why, how you'll run
the ported tests, and how each reference name maps to your language. STOP.

Build in this order. For each step, read the named SPEC.md section and source file, port the listed tests, and
make them pass before moving on.

1. Session: createSession({ facts }) (id "s_" + 12 hex, rev 0, status "open"), forget(session) returning
   { v: 1, id, forgotten: true }. Never mutate a session you were given.
   SPEC: 7. Source: src/session.ts. Tests: test/session.test.ts.
2. Tools: read/write declarations (explicit snake_case name, description, input schema, visible, bind, confirm,
   beforeVerification, verifies, records, run, and for writes outcome, reconcileWith and repeatable); the
   model-facing JSON Schema without bound fields; bound fields injected from facts and overriding the model;
   missing_fact; invalid_input before run; ToolError(code, message, { outcome: "unknown" }?) passed through and
   any other error turned into internal_error without its message; records applied only on success; write
   outcomes on each tool result (a success is "done" unless outcome(output) says "pending"; a ToolError with
   outcome "unknown" records ok: false, outcome "unknown"; a plain ToolError records no outcome, a known
   failure); visible paths ("a.b", "items[].c"), default hiding of personal-looking field names,
   masking, strictVisibility.
   SPEC: 1. Source: src/tools.ts, src/privacy.ts. Tests: test/tools.test.ts, including "write outcomes on tool
   results".
3. Checks: the Check type, allow/block/rewrite/handoff helpers, the context passed to checks, and the pipeline
   (built-ins, then journey guardrails, then custom checks; for actions the first non-allow wins and rewrite is
   an error; for replies rewrites chain, block or handoff stops, and a rewrite is attributed to the last check
   that rewrote the text).
   SPEC: 4. Source: src/checks.ts. Tests: the pipeline cases in test/builtins.test.ts.
4. Claims and no_unconfirmed_claims: extract money, percentages, dates, relative dates and "done" language;
   drop done phrases whose clause is negated (comma-split clauses, "nothing"/"none"/"no" as negations,
   "no problem"/"no worries" as interjections) or that report status ("all set staying..."); normalize
   numbers; match by kind (field names decide the kind for tool values, written form decides it for operator
   text); confirmed sources are visible tool results, commitments and operator text, never customer text; the
   refusal allowance (a number the customer said may appear only inside the agent's own refusal that governs
   it, and comparatives like "lower than" or "better deal than" disqualify it); markShown. Then write outcomes,
   from each write tool's latest call: done, pending, failed, or unknown until a later successful call of its
   reconcileWith read. While any is unknown, block every draft, whatever it says, naming the read to call
   (or, with no reconcileWith, telling the model to hand off). The failure-language guard: failure wording ("didn't go through", "failed", "nothing has been
   changed"...) is blocked when no write failed and one is done. Done wording is blocked while a write failed or
   is pending; "went through" and "has gone through" are done wording; a bare "you're all set" is blocked only
   after a failed, pending or unknown write.
   SPEC: 5.3 and 5.4. Source: src/claims.ts. Tests: test/claims.test.ts, with test/fixtures.ts, including the
   v4 tables "write outcomes: done / pending / failed / unknown" and "bare 'all set' as a pleasantry".
5. The other built-ins: verified_first (when it switches off, and the exact startup warning), yes_after_quote
   (affirmative and proceed-request detection, including "go with that", "I'll take it", "n't" as a negation
   and lower-cased custom phrases; quote commitments that must exist, be open and unexpired, and be shown in an
   earlier turn), handoff_after_failures, no_repeated_writes (a write that already succeeded in this turn is
   blocked, with the prior result in the exact block reason, unless the tool is repeatable; a call this turn
   with an unknown or pending outcome blocks a retry even when the tool is repeatable; an earlier turn or a
   known failure doesn't count). With untrusted_text_is_data that makes six built-ins; the pipeline test
   fixes the order of the other five. untrusted_text_is_data is structural and is built in steps 2 and 6.
   SPEC: 5.1, 5.2, 5.5, 5.6. Source: src/builtins.ts. Tests: the rest of test/builtins.test.ts, including
   "no_repeated_writes (v4 b)".
   STOP: show me pass counts for every table in steps 1 to 5, allowed and attack rows separately, and each
   deviation you had to resolve.
6. The agent loop, respond(session, message) returning { reply, session, handoff?, usage }. History rebuilt
   from the session with bound fields stripped. Customer text and tool output fenced as data with angle
   brackets escaped, and the system prompt's data rule copied exactly. System notes outside the fences. A
   blocked action returned to the model as a "Not run. Blocked: ..." error. A blocked reply retried up to
   maxRetries, then handed off. maxToolCalls. Auto-reconcile: after a write ends with an unknown outcome and
   declares reconcileWith, run that read before the next model call when its input can be built from the
   failed call's input and bound fields (SPEC section 2). The handoff_to_person tool. Journey handoffs checked before any
   model call. Commitments marked as shown; a successful confirm write spends only the commitment matching both
   its id and its type; rev + 1 per turn; a handed-off session returns the handoff message without calling
   the model.
   SPEC: 2, 3. Source: src/agent.ts. Tests: test/agent.test.ts, driven by a scripted fake model (port
   test/fake-model.ts), including the open_case-redraft case for no_repeated_writes. No network in these tests.
7. One model adapter over plain HTTP: the Model interface (id, generate), ModelError, a single retry on 429, 5xx
   or a network error, no sampling parameters unless passed in extra, "provider:model" strings with keys read
   from the environment, and raw provider blocks echoed back within a turn.
   SPEC: 8. Source: src/models/. Tests: test/adapters.test.ts with the HTTP layer mocked.
8. Journeys: load YAML with positions, validate against the journey JSON Schema in SPEC.md, report every error
   as file:line:col, fail on unknown tools, unknown checks and disabled built-ins, render the journey prose into
   the prompt ("## Journey: <id>"), and compile the guardrail kinds.
   SPEC: 6. Source: src/journeys.ts. Tests: test/journeys.test.ts, using test/journeys/plan-change.yaml
   unchanged.
9. Traces: the sink interface { write, forget?, mask? }. The agent masks every line before write() whatever the
   sink, unless the sink sets mask: false; type, sessionId and turn are never masked; expose the masker as
   maskTrace. The default JSONL sink writes one file per session and its forget deletes that file.
   agent.forget(session) calls the sink's forget (or warns once) and returns the tombstone.
   SPEC: 9 and 7. Source: src/trace.ts, src/privacy.ts, src/agent.ts. Tests: the trace and forget cases in
   test/agent.test.ts.
10. Simulator and commands. Task loader and validation before any model call (stand-ins cover exactly the
    tools; tasks name real tools, including allowed_writes; expected writes run on the seed, honouring
    allow_error). createStore and state() may be async: await both, for the live store and the expected one. The simulated-customer prompt and its ###STOP###, ###TRANSFER### and ###OUT-OF-SCOPE###
    endings. Deterministic grading with no LLM judge: final state (an awaited, possibly async state(), with
    allowed_writes replayed into the expected store), expected writes, forbidden actions, handoff, and claims.
    Each sent reply's claims are checked against the session as it was when that reply was sent, not the final
    session. The task fields allow_in_refusal, must_not_claim_done and forbidden_phrases use the grader's own
    matchers (negation-, conditional- and purpose-aware; a negative phrase can't excuse itself with its own
    "n't"), kept independent of the claims code. pass^k over scored trials (infrastructure errors excluded),
    friction, cost and per-trial token counts.
    `test --suite <dir> [--k 4] [--tasks a,b] [--agent-model provider:model] [--max-cost 10] [--min-pass 1]
    [--against <name>]` with the cost estimate from the last run's tokens at current prices, the snapshot diff,
    and the gate: exit 0 passed, 1 when pass^k < --min-pass or a task flipped pass→fail vs the snapshot
    ("FAILED the gate"), 2 on errors; an unknown --against name fails before any model call.
    `snapshot --suite <dir> --name v1`, with the same config fingerprint (library = every compiled source
    file of the port, recursively, in a stable order).
    SPEC: 10, 11, 12. Source: src/sim/, src/cli.ts. Tests: test/sim.test.ts, test/cli.test.ts.

FINAL CONFORMANCE (SPEC: 13)
Port examples/subscriptions: store (data and rules), tools, agent config and the suite. Reuse journeys/*.yaml,
knowledge/policy.md and sim/tasks/*.yaml unchanged, with the same fixed clock, models and prices. Tell me the
estimated cost and wait for my OK: this step calls a model and costs real money. Then run the suite with k = 4
and compare with snapshots/v4-sonnet.json (and v4-haiku.json if you also run the smaller agent model) in the
reference repo, at tag v4. The reference scored 100% pass^4 for Sonnet 5.5 (22/22 tasks, 88/88 trials) and
77% for Haiku 4.5 (17/22 tasks, 79/88 trials). Compare each task's trial marks (e.g. PPPF = 3/4), not just
pass^4: at k = 4 one borderline task moves the overall pass^4 by about 4.5 points on those 22 tasks, so a
single flaky task can look like a regression. Haiku's reference failures are mostly unneeded handoffs, which
vary from run to run. The config fingerprints will differ because the code differs; compare task outcomes. For every task that differs, show the failing
grade component and the transcript, and say whether the cause is the port, the reference grader, or model
variance (rerun that task before blaming variance). STOP.
````
