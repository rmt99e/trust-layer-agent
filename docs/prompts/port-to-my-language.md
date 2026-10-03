# Prompt: port trust-layer-agent to my language

trust-layer-agent is a small trust layer for customer-facing agents: tools gated by checks in code, replies that can't claim what no tool confirmed, customer data shown to the model only on a need-to-know basis, and releases that must pass simulations first.

SPEC.md defines the parts that don't depend on a language: the session JSON, the check result shape, the journey schema and the simulation task format. The TypeScript package is the reference implementation. This prompt has your coding agent build a port in another language, smallest piece first, using the reference tests as conformance cases. It finishes by running the same simulation suite the reference passes and comparing the scores. It stops for your OK after the plan and after the check tables pass. Only the last step costs money.

Replace `<language>` and `<repo-url>`, then copy everything inside the block into your coding agent.

````text
Port trust-layer-agent to <language>. Reference repo: <repo-url>. Clone it and read SPEC.md, then src/ (about
1,300 lines of TypeScript), test/ and examples/subscriptions/. SPEC.md is the contract. Where SPEC.md, the
source and the tests disagree, the source and its tests win; list every disagreement for me.

The idea to keep intact: the model chooses the words; code decides what's allowed. Three things a user writes
(tools, checks, journeys), one call (respond), two commands (test, snapshot), four extension points (tools,
checks, journeys, model adapters). Don't add features. Put ideas in a list for me instead.

RULES
- Dependencies: a schema validator that can emit JSON Schema, and a YAML parser that keeps line numbers. Use
  the standard library for HTTP, JSON, UUIDs and files. No model provider SDKs and no agent framework.
- Same wire formats, byte for byte where it matters: session JSON (v, id, rev, status, facts, commitments,
  results, messages, failures), check results ({allow: true} | {block} | {rewrite} | {handoff}), journey and
  task YAML, trace lines, results/ and snapshots/ JSON. A session saved by the TypeScript package must load in
  the port and the other way round.
- Checks are deterministic code. Copy phrase lists, regexes, block reasons and notes exactly (SPEC.md requires
  the exact strings), then fix regex-dialect differences until the reference tables pass: \b is the ASCII word
  boundary, and lookbehind and case folding vary by language. Round money to the cent the way
  the reference does (Math.round(x * 100) / 100, which rounds halves up). Many languages round halves to even.
- Port each reference test file as conformance cases: same rows, same expected outcomes. Keep the rows marked
  as known false positives; they document behavior. Never change an expected outcome to make a port pass.
- Idiomatic names are fine (createSession may become create_session). Behavior and JSON stay the same.

STEP 0: Plan. Show me the module list in build order, the two dependencies you chose and why, how you'll run
the ported tests, and how each reference name maps to your language. STOP.

Build in this order. For each step, read the named SPEC.md section and source file, port the listed tests, and
make them pass before moving on.

1. Session: createSession({ facts }) (id "s_" + 12 hex, rev 0, status "open"), forget(session) returning
   { v: 1, id, forgotten: true }. Never mutate a session you were given.
   SPEC: Session. Source: src/session.ts. Tests: test/session.test.ts.
2. Tools: read/write declarations (explicit snake_case name, description, input schema, visible, bind, confirm,
   beforeVerification, verifies, records, run); the model-facing JSON Schema without bound fields; bound fields
   injected from facts and overriding the model; missing_fact; invalid_input before run; ToolError(code,
   message) passed through and any other error turned into internal_error without its message; records applied
   only on success; visible paths ("a.b", "items[].c"), default hiding of personal-looking field names,
   masking, strictVisibility.
   SPEC: Tools. Source: src/tools.ts, src/privacy.ts. Tests: test/tools.test.ts.
3. Checks: the Check type, allow/block/rewrite/handoff helpers, the context passed to checks, and the pipeline
   (built-ins, then journey guardrails, then custom checks; for actions the first non-allow wins and rewrite is
   an error; for replies rewrites chain, and block or handoff stops).
   SPEC: Checks. Source: src/checks.ts. Tests: the pipeline cases in test/builtins.test.ts.
4. Claims and no_unconfirmed_claims: extract money, percentages, dates, relative dates and "done" language
   (with negation); normalize numbers; match by kind (field names decide the kind for tool values, written form
   decides it for operator text); confirmed sources are visible tool results, commitments and operator text,
   never customer text; markShown.
   SPEC: 5.3 and 5.4 (claims). Source: src/claims.ts. Tests: test/claims.test.ts, with test/fixtures.ts.
5. The other built-ins: verified_first (and when it switches off), yes_after_quote (affirmative and
   proceed-request detection, quote commitments that must exist, be open and unexpired, and be shown in an
   earlier turn), handoff_after_failures. untrusted_text_is_data is structural and is built in steps 2 and 6.
   SPEC: Built-in checks. Source: src/builtins.ts. Tests: the rest of test/builtins.test.ts.
   STOP: show me pass counts for every table in steps 1 to 5 and each deviation you had to resolve.
6. The agent loop, respond(session, message) returning { reply, session, handoff?, usage }. History rebuilt
   from the session with bound fields stripped. Customer text and tool output fenced as data with angle
   brackets escaped, and the system prompt's data rule copied exactly. System notes outside the fences. A
   blocked action returned to the model as a "Not run. Blocked: ..." error. A blocked reply retried up to
   maxRetries, then handed off. maxToolCalls. The handoff_to_person tool. Journey handoffs checked before any
   model call. Commitments marked as shown, a quote spent on a successful confirm write, rev + 1 per turn, and a
   handed-off session returning the handoff message without calling the model.
   SPEC: respond(), Prompt assembly and fencing. Source: src/agent.ts. Tests: test/agent.test.ts, driven by a
   scripted fake model (port test/fake-model.ts). No network in these tests.
7. One model adapter over plain HTTP: the Model interface (id, generate), ModelError, a single retry on 429, 5xx
   or a network error, no sampling parameters unless passed in extra, "provider:model" strings with keys read
   from the environment, and raw provider blocks echoed back within a turn.
   SPEC: Model adapters. Source: src/models/. Tests: test/adapters.test.ts with the HTTP layer mocked.
8. Journeys: load YAML with positions, validate against the journey JSON Schema in SPEC.md, report every error
   as file:line:col, fail on unknown tools, unknown checks and disabled built-ins, render the journey prose into
   the prompt ("## Journey: <id>"), and compile the guardrail kinds.
   SPEC: Journeys. Source: src/journeys.ts. Tests: test/journeys.test.ts, using test/journeys/plan-change.yaml
   unchanged.
9. Traces: one JSONL file per session; emails, phones, addresses, SSNs and card numbers masked unless turned
   off; turn, tool and check lines.
   SPEC: Traces and privacy. Source: src/trace.ts, src/privacy.ts. Tests: the trace cases in test/agent.test.ts.
10. Simulator and commands. Task loader and validation before any model call (stand-ins cover exactly the
    tools; tasks name real tools; expected writes run on the seed). The simulated-customer prompt and its
    ###STOP###, ###TRANSFER### and ###OUT-OF-SCOPE### endings. Deterministic grading on final state, expected
    writes, forbidden actions, handoff and claims, with no LLM judge and a grader matcher kept independent of
    the claims code. pass^k over scored trials (infrastructure errors excluded), friction and cost.
    `test --suite <dir> [--k 4] [--tasks a,b] [--agent-model provider:model] [--max-cost 10]` and
    `snapshot --suite <dir> --name v1`, with the same config fingerprint and snapshot diff.
    SPEC: Simulation suites and tasks, Grading and scoring, Commands and snapshots. Source: src/sim/,
    src/cli.ts. Tests: test/sim.test.ts, test/cli.test.ts.

FINAL CONFORMANCE (SPEC: Conformance)
Port examples/subscriptions: store (data and rules), tools, agent config and the suite. Reuse journeys/*.yaml,
knowledge/policy.md and sim/tasks/*.yaml unchanged, with the same fixed clock, models and prices. Tell me the
estimated cost and wait for my OK: this step calls a model and costs real money. Then run the suite with k = 4
and compare each task's pass^4, and the overall score, with snapshots/v2.json in the reference repo. The config
fingerprints will differ because the code differs; compare task outcomes. For every task that differs, show
the failing grade component and the transcript, and say whether the cause is the port or model variance (rerun
that task before blaming variance). STOP.
````
