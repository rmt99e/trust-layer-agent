# Testing your agent

The reference for the `test` and `snapshot` commands and for suites. The README has the short version; [SPEC.md](../SPEC.md) §10–12 is normative for task files, grading and snapshots.

## `test` flags

- `--k`: trials per task (default 4).
- `--min-pass`: the pass^k fraction required (default 1).
- `--max-cost`: stops the run at that many dollars (default 10).
- `--tasks a,b`, `--agent-model provider:model`.
- Exit codes: 0 when the gate passes; 1 when pass^k is below `--min-pass` or a task flipped pass→fail against the snapshot; 2 on errors.

`snapshot` pins the latest results with fingerprints of the models, instructions, journeys, knowledge, tools, checks and library code, and refuses if any of them changed since the last `test`.

## What a suite exports

A suite is a `suite.js` that exports the agent options, your tools, a stand-in `run` per tool over a fresh seeded store, `createStore()`, a `state()` function for the grader, the tasks directory, the agent and user models, and prices. `createStore()` and `state()` may be async, so the store can be a seeded test database. See [sim/suite.js](examples/subscriptions/sim/suite.js). A task is YAML:

## Task fields

Other `expect` fields: `forbidden_actions`, `must_handoff`, `required_claims`, `forbidden_claims` (e.g. `[{ money: 10 }]`), `allow_in_refusal` and `must_not_claim_done`. A simulated user plays the persona. Grading is deterministic, with no LLM judge: the final data state must equal the seed with the expected writes applied, forbidden actions must not have run, the handoff must match, required claims must appear, and no sent reply may contain an unconfirmed or forbidden claim. Model outages count as infrastructure errors, not failures.

## pass^k

pass^k is the share of tasks whose k trials all passed; a task that passes 3 of 4 trials counts as a fail. Report trial counts (passing trials / total) next to it.
