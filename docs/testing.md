# Testing your agent

The reference for the `test` and `snapshot` commands and for suites. The README has the short version; [SPEC.md](../SPEC.md) §10–12 is normative for task files, grading and snapshots.

## `test` flags

- `--suite <dir>`: the suite to run (a directory with `suite.js`).
- `--k`: trials per task (default 4).
- `--min-pass`: the pass^k fraction required (default 1).
- `--max-cost`: stops the run at that many dollars (default 10).
- `--against <name>`: diff this run against `snapshots/<name>.json`, task by task, and fail on a pass→fail flip.
- `--tasks a,b`, `--agent-model provider:model`.
- Exit codes: 0 when the gate passes; 1 when pass^k is below `--min-pass` or a task flipped pass→fail against the snapshot; 2 on errors (a bad flag value, an unknown command, a suite that fails validation).

`snapshot --suite <dir> --name <name>` pins the latest results with fingerprints of the models, instructions, journeys, knowledge, tools, checks and library code, and refuses if any of them changed since the last `test`.

## What a suite exports

A suite is a `suite.js` that exports the agent options, your tools, a stand-in `run` per tool over a fresh seeded store, `createStore()`, a `state()` function for the grader, the tasks directory, the agent and user models, and prices. `createStore()` and `state()` may be async, so the store can be a seeded test database. See [examples/subscriptions/sim/suite.js](../examples/subscriptions/sim/suite.js).

## Task fields

A task is a YAML file with an `id`, a `user` block (`persona`, `reason`, `known_info`, `unknown_info`, `instructions`) that drives the simulated user, `max_steps`, and an `expect` block:

- `writes`: the writes that must have happened, applied to a copy of the seed to produce the expected final state; each has `tool`, `input`, the `compare` fields, and optionally `allow_error` for a write that may end in a named ToolError (a write that applies, then times out).
- `allowed_writes`: tools whose extra successful calls are fine in this task.
- `forbidden_actions`: tools that must not have run successfully.
- `must_handoff`: whether the trial must end in a handoff.
- `required_claims` and `forbidden_claims` (e.g. `[{ money: 10 }]`): what a sent reply must, or must never, state.
- `allow_in_refusal`: a forbidden value may appear inside the agent's own refusal that governs it.
- `must_not_claim_done` and `forbidden_phrases`: wording no sent reply may assert.

A field declared `secret` on a tool is `[redacted]` in the recorded input, so it can't be in `compare`. Grading is deterministic, with no LLM judge: the final data state must equal the seed with the expected writes applied, forbidden actions must not have run, the handoff must match, required claims must appear, and no sent reply may contain an unconfirmed or forbidden claim. Model outages count as infrastructure errors, not failures.

## pass^k

pass^k is the share of tasks whose k trials all passed; a task that passes 3 of 4 trials counts as a fail. Report trial counts (passing trials / total) next to it.
