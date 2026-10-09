# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from its first release.

`v1` to `v4` are internal milestones (git tags), not npm releases. The first npm release will be **0.1.0**: package.json is already at 0.1.0, but nothing has been published to npm yet. Until then, install from GitHub; a `prepare` script builds the package on install. The `v0.1.0` git tag (2026-10-05) marks the first public release on GitHub.

## [Unreleased]

### Changed

- **The party the agent talks to is the `user`, not the `customer`.** The library is a trust layer for any LLM agent that acts on someone's behalf; customer support is one journey. Renamed, with no aliases: the message role `customer` → `user`; the prompt fence `<customer_message>` → `<user_message>` and the data rule's wording; the journey guardrail `customer_says` → `user_says`; the task file block `customer:` → `user:` and its `reason_for_call` → `reason`; the suite field `customerModel` → `userModel`; the tool declaration `fromCustomer` → `fromUser`; the `turn` trace field `customer` → `user`; trial `tokens.customer` and transcript roles → `user`; the default `handoff_to_person` summary → `User asked for a person.`; every block reason that said "the customer" now says "the user". **Session schema is v2**: `createSession` and `forget` write `v: 2`, and `loadSession` upgrades a v1 session (role rename, `approvals` filled in), so stored sessions keep working; every agent method loads through it. Journey and task files must be updated by hand (the loader reports the unknown key with file and line). `test --against` an older snapshot reports `userModel` as a config difference, since the key is new, so against the committed snapshots a real user-model change is no longer distinguishable from the rename. The fence, the data rule, the block reasons and the simulated user's prompt are model-facing text, so this is a behavior change in the CONTRIBUTING sense: a maintainer should run `test --against v4-sonnet` and take a fresh snapshot.

### Added

- **Session stores.** `SessionStore` (`load`, `save(session, expectedRev)`) turns the session's `rev` into a real optimistic lock: a save against a stale rev throws `StaleSession`, so two requests for one conversation can't overwrite each other. `withStore(agent, store)` gives the agent's verbs by session id (`respond`, `approve`, `decline`, `review`, `forget`), each loading, acting and saving against the rev it loaded; `forget` deletes the trace and stores a tombstone that `load` returns. `memoryStore()` is the reference and the contract tests run against every store. `trust-layer-agent/postgres` is a Postgres store plus trace sink over the app's own query function (no database dependency), with `schema` to create the two tables.

- **`approve(reason)`**, a fifth check result for actions: the tool doesn't run and isn't refused; it is parked on the session as an `Approval` (`session.approvals[]`, also returned as `approvals` on the reply) for a person to decide. The model is told the action is requested, not done; `no_unconfirmed_claims` blocks "done" wording about that write until it runs; each later turn carries a note listing what is still pending, and an identical call isn't parked twice. **`agent.approve(session, id)`** runs the parked call with its recorded input (bind from current facts, no action checks) and **`agent.decline(session, id, reason?)`** records a failed call with code `declined`; either way the result is an ordinary ToolResult the model sees next turn. `rev` increases on each decision. Trace lines: `check` gains `approval` on a parked action; a new `approval` line records the decision.
- **`agent.review(session | null, draft)`**: runs the reply checks on a message the app wrote itself (a rendered template, an outbound notice) and returns the verdict (`{ result, by?, text?, trail }`). No model call, no session change, one `review` trace line.
- **Operator-defined claim kinds**: `builtins: { no_unconfirmed_claims: { kinds: [{ name, find, confirms? }] } }` extends the claim check to an app's own vocabulary (counts, status words, reference numbers). `find` is a RegExp or a function; by default any string or number in a tool output, commitment or operator text backs a claim, or `confirms(source)` decides. The simulator's grader applies the suite's kinds.
- **`fromUser`** on a tool and the built-in check **`no_invented_inputs`**: listed input fields must hold values the user gave (whole-word, case-insensitive, in a user message) or a session fact. Tool output never counts, so a tool can't search for something it only discovered. A field can't be both bound and `fromUser`. Journeys may list the check; `builtins: { no_invented_inputs: false }` turns it off.
- `loadSession(session)`: a copy of a stored session upgraded to the current schema (v1's `customer` role → `user`, `approvals` filled in). `respond()`, `review()`, `approve()` and `decline()` all load this way. `SessionV1` is exported for apps that type their stored rows.
- System notes escape anything interpolated from outside the library (an invented tool name, a check's block reason, a parked action's input), so model or user text can't forge a `<system_note>` through a note. The snapshot fingerprint covers `fromCustomer` and the claim kinds' source text.
- Exports: `approve`, `loadSession`, and the types `Approval`, `ClaimKind`, `Verdict`.

### Changed

- The `src/` logic-line cap is 1,500 (was 1,400); `src/` is at 1,484.

- v4.2: **code reconciles unknown outcomes before any reply.** When a write ends with an unknown outcome and declares `reconcileWith`, the agent runs that read itself before the model replies, if every input the read needs is bound or present in the failed call. Its visible result is added to the write's tool message as `reconcile: { tool, output }`, and the trace marks it `reconcile: true`. If the read can't be run (it needs inputs code doesn't have) or fails, every draft is blocked until a successful reconcile read; a handoff is still possible. In rehearsal, a reply implied failure ("our team will handle your switch… you should hear back soon") without any failure phrase; this closes that gap.
- Demo toggles in examples/subscriptions/chat.js: `CHANGE_PLAN_OUTCOME=fail|timeout|pending` (`FAIL_CHANGE_PLAN=1` still means fail) and `AGENT_MODEL=sonnet|haiku`. The `chat()` view labels code's re-check `(auto re-check)`.

- Install from GitHub: a `prepare` script runs the build, so `npm install` from the repository gets compiled JavaScript and types.
- package.json: a `bugs` field, and CHANGELOG.md in the published package files.
- Snapshots: v3-sonnet-regraded and v3-haiku-regraded, the v3 results re-graded offline with the fixed grader.
- Docs: README, SPEC.md (language-neutral spec), AGENTS.md, llms.txt, copy-paste prompts for adding the trust layer to a JS/TS app and for porting it to another language, this changelog, a build log ([docs/how-it-was-built.md](docs/how-it-was-built.md)), CONTRIBUTING.md, SECURITY.md, a CI workflow and issue templates.

### Changed

- v4.1: `no_repeated_writes` also blocks retrying a write whose latest call this turn has an unknown or pending outcome, even if the write is `repeatable`, because it may already have applied. The reason tells the model to call its `reconcileWith` read. Known failures stay retryable; an unknown outcome can be retried in a later turn.
- v4.1: `reconcileWith` is validated at construction: it must name a read tool of the same agent, or `new Agent()` throws, naming both tools.
- v4.1: if a write's `outcome(output)` throws, the call is treated as outcome `unknown` and the error is recorded as `outcomeError` in the session and trace; the turn doesn't crash.
- v4.1: the snapshot fingerprint's `tools` hash covers each tool's `outcome` function source, `reconcileWith` and `repeatable`, so changing any of them is reported as a config change.
- v4.2: while a write's outcome is unknown, `no_unconfirmed_claims` blocks every draft, not only "done" and failure wording: `Call <read> before replying; the outcome of <write> is unknown.`
- A suite's `createStore()` may be async (for example, a store backed by a database), like `state()`.
- `runSuite()`'s default cost cap is 10, the same as the CLI's `--max-cost` default. It was 5.
- docs/design.md now opens with a note that SPEC.md describes current behavior.
- README rewritten in plain, factual language; the v1–v4 results history moved to docs/how-it-was-built.md. The package description, SPEC.md, AGENTS.md, llms.txt, CONTRIBUTING.md, SECURITY.md and the copy-paste prompts were updated to match, and stale v4.1/v4.2 statements about unknown outcomes and repeated writes were corrected.

## [v4] - 2026-10-05

Internal milestone: write outcomes, reconciliation reads and no repeated writes, aimed at the harm v3 found. On the 22-task suite at k=4: Sonnet 5.5 pass^4 100% (22/22, 88/88 trials, $5.05); Haiku 4.5 77% (17/22, 79/88 trials, $2.59), and its false "it failed" replies on timeout-applied went 3 → 0. A new harm was found: Haiku claimed a cheaper plan "covers your usage easily" when it didn't, then switched the customer to it.

### Added

- Write outcomes. A write's `outcome(output)` reads a successful result as `"done"` or `"pending"` (default `"done"`). `ToolError` takes `{ outcome: "unknown" }` for a write that may have happened, such as a timeout. Tool results record the outcome; a failed call without one is a known failure.
- `reconcileWith` on a write names the read tool that settles an unknown outcome.
- New built-in check `no_repeated_writes`, on by default: a write that already succeeded this turn can't run again. `repeatable: true` on a write opts out; `no_repeated_writes: false` turns the check off.
- Simulation tasks: `allowed_writes` lists extra writes that are fine in a task (for example `open_case`); they are replayed into the expected state instead of failing it. Used by pending-change, timeout-applied and partial-refund.
- Subscriptions example: `change_plan` declares pending vs done and reconciles with `get_account`; `refund_invoice` reconciles with `get_invoices`; the timeout-applied store raises an unknown-outcome `ToolError`.
- Snapshots: v4-sonnet and v4-haiku.

### Changed

- `no_unconfirmed_claims`: after an unknown outcome, a reply can't say the write worked or that it failed until the `reconcileWith` read has succeeded.
- `no_unconfirmed_claims`: failure language ("didn't go through", "failed", "wasn't applied", "no changes were made") is blocked when the latest write succeeded and nothing failed.
- `no_unconfirmed_claims`: done language is blocked while a write is pending, and "went through" / "has gone through" count as done language.
- Grader: `forbidden_phrases` and `must_not_claim_done` count only asserted uses. Negated, conditional, future or purpose clauses ("the full refund didn't go through", "once it goes through", "so someone confirms it went through") no longer count. A negative forbidden phrase such as "didn't go through" can't excuse itself with its own negation. Re-grading the saved v3 results offline moved Sonnet from 86% (19/22) to 95% (21/22); Haiku stayed at 73% (16/22).

### Fixed

- A bare "you're all set" with no action verb is no longer blocked just because no write succeeded. It is still blocked after a failed, pending or unknown write.
- Structural trace fields are never masked. A session id with 10 or more consecutive digits was masked as a phone number, so its trace was written under a masked file name and `forget()` missed it.

### Known issues

- Fit and eligibility claims ("Starter covers your usage easily") aren't checked: they are judgments, not numbers, dates or done language.
- Done language isn't tied to which write succeeded: after only `open_case` succeeded, "switched to Plus" is allowed.
- Haiku's unneeded handoffs rose from 5 to 8 of 72 trials on the original 18 tasks. Checks can't stop a handoff the model chooses.

## [v3] - 2026-10-04

Internal milestone: behavior-neutral fixes, a re-baseline, wording fixes with attack tests, and harm-tempting tasks. On the existing 18 tasks Sonnet 5.5 stayed at pass^4 100% (18/18) with friction 25 → 9, and Haiku 4.5 went 94% (17/18) → 83% (15/18) with friction 58 → 65. On the full 22-task suite: Sonnet 86% (19/22, 81/88 trials, $5.02), Haiku 73% (16/22, 75/88 trials, $2.63). The new tasks found the first real harm: Haiku said a plan change had failed when it had applied, in 3 of 4 timeout-applied trials.

### Added

- Four harm-tempting simulation tasks: pending-change, timeout-applied, partial-refund and injected-tool-text. The subscriptions store can make a plan change pending, apply it and then time out, or refund only part of an invoice.
- Grader assertions: `must_not_claim_done` (no sent reply may say an action happened), `forbidden_phrases` (phrases no sent reply may contain), `allow_in_refusal` (a forbidden value may appear inside a refusal that governs it), and `allow_error` on an expected write (that step may end in a given error, such as a write that applies and then times out).
- CLI: `test --against <snapshot>` diffs against a named snapshot, and `--min-pass` (default 1, meaning 100%) sets the gate.
- `maskTrace` is exported, and trace sinks may implement `forget(sessionId)`.
- Subscriptions example: a checks-off mode for comparison runs. `TRUST_LAYER_CHECKS=off` keeps every prompt (instructions, journey guidance, knowledge) but turns off the built-in checks and strips journey guardrails, so the rules exist only as prompt text. Bind injection and field visibility stay on.
- Snapshots: v2.1-sonnet and v2.1-haiku (pre-v3 baselines on the new library), v3-sonnet and v3-haiku.
- Package metadata, a `trust-layer-agent` bin entry, a prepublish build, and version 0.1.0.

### Changed

- A number only the customer said may be repeated inside the agent's own refusal that governs it ("I can't offer Plus at $10 a month"). It still never confirms a claim. The refusal must be the agent's ("I" or "we"), so "You won't get a better deal than $10" still blocks, and a comparative ("I can't go lower than $10") disqualifies the allowance.
- More consent phrases count as a yes after a shown quote ("let's go with that", "I'll take it"); their negations don't.
- `test` exits 1 when pass^k is below `--min-pass` or any task flipped pass→fail since the snapshot, and 2 on errors. It used to exit 0 regardless.
- The grader checks each sent reply against the session as it was when the reply was sent, not the final session.
- `suite.state()` may be async, so a suite can read its state from a database.
- The library fingerprint in snapshots covers every compiled file, including the simulator and model adapters.
- The cost estimate before a run prices the last run's tokens at the current models' prices, instead of reusing the last run's cost.
- `agent.forget(session)` also deletes the session's trace when the sink supports it, and warns once when it doesn't.

### Fixed

- Traces are masked for every sink, not only the built-in JSONL sink, unless the sink sets `mask: false`.
- Negated subjects ("Nothing has been changed", "No changes were made") are no longer treated as done claims; interjections ("No problem, your plan has been switched") still are.
- Status phrases ("You're all set staying on your Starter plan") are no longer treated as done claims when they don't claim a change.
- A quote-backed write marks only its own kind of commitment as used.
- Custom consent phrases are lower-cased before matching.
- The trace names the check that rewrote a reply.
- The startup warning when no tool can verify a customer says that sessions the app creates with `verified` facts are still checked.
- Clearer block reason when an `allow_values` guardrail blocks an action: "(none)" when the source tool returned nothing, "(not called yet)" when it wasn't called.

### Known issues

- A claim that an action failed is not guarded when the outcome is unknown (a timeout). Addressed in v4.
- A draft retried after a block can repeat a write that has no quote behind it (up to 4 `open_case` calls in one turn). Addressed in v4.

## [v2] - 2026-10-02

Internal milestone: the simulator, a v1 baseline, and three fixes it found. pass^4 89% → 100% on 18 simulation tasks × 4 trials; run cost $4.14 → $4.12; total friction (blocked drafts and actions) 20 → 25.

### Added

- The simulator: simulated customers driven by task personas, deterministic grading on final data state, required and forbidden actions, required claims, an independent matcher for forbidden claims, friction reported separately from failure, infrastructure errors excluded from scoring, and pass^k.
- CLI: `trust-layer-agent test` (pass^k per task, cost estimate before the run, a spend cap, diff against the latest snapshot) and `trust-layer-agent snapshot` (fingerprints the model, instructions, journeys, knowledge, tools, checks, suite and library code).
- 18 simulation tasks for the subscriptions example, including adversarial ones (a lowball price, a fake authority claim, someone else's account, prompt injection).
- snapshots/v1.json: the baseline for v1's checks, pass^4 89% (16 of 18 tasks) at $4.14. The two failures were correct refusals whose replies still repeated a forbidden number.

### Fixed

- Claims are matched by unit. A number in a reply is confirmed only by a tool value of the same kind (money, percent, plain number), with the kind inferred from the field name. Before, "$10" passed as confirmed by an unrelated 10% discount, and "50%" by a $50 savings figure.
- Dates are confirmed by tool timestamps (an ISO timestamp confirms its calendar date) and by the agent's own clock.
- Negated "done" language ("it hasn't been switched") is no longer treated as a done claim.
- A request to proceed ("go ahead", "switch me") after a quote was shown in an earlier reply counts as consent; questions about cost don't.
- Replies no longer mention internal mechanics (checks, blocks).

### Known trade-off

- Friction rose because stricter number guarding blocks refusals that repeat the customer's own number ("I can't do Plus for $10"), so the agent needs another draft.

## [v1] - 2026-10-02

Internal milestone: the runtime, both model adapters and the subscriptions example. The runtime is tested with a scripted fake model; the anthropic adapter was smoke-tested with a real call, and the openai-compatible adapter only against mocked HTTP.

### Added

- Tools: `read()` and `write()` with explicit names, input schemas, `bind` injection from session facts, field-level `visible` lists with personal-data fields hidden by default, `records` applied only on success, `confirm` for quote-backed writes, and `ToolError`.
- Checks: one function type returning allow, block, rewrite or handoff, guarding both actions and replies. Built-ins on by default: `verified_first`, `yes_after_quote`, `no_unconfirmed_claims`, `untrusted_text_is_data` (structural fencing of customer and tool text), `handoff_after_failures`.
- Session as plain JSON with facts, commitments, messages and tool results; `createSession()` and `forget()`.
- `agent.respond()` and `agent.chat()`; JSONL traces with emails, phone numbers and addresses masked.
- Journeys in YAML with enforced guardrails and prompt-only guidance, validated on load with file and line in errors.
- Model adapters for `anthropic` and `openai-compatible`, using plain `fetch`.
- The subscriptions example: the 10-line refunds quickstart and the full plan-change agent (verification, usage, eligible plans, quotes, plan change, refunds, usage packs, cases and handoff) over a seeded in-memory store.

[Unreleased]: https://github.com/rmt99e/trust-layer-agent/compare/v4...HEAD
[v4]: https://github.com/rmt99e/trust-layer-agent/compare/v3...v4
[v3]: https://github.com/rmt99e/trust-layer-agent/compare/v2...v3
[v2]: https://github.com/rmt99e/trust-layer-agent/compare/v1...v2
[v1]: https://github.com/rmt99e/trust-layer-agent/releases/tag/v1
