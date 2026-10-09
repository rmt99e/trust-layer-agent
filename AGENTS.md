# AGENTS.md

Notes for coding agents working on this repo. For using the package in an app, read README.md.

trust-layer-agent is a trust layer for LLM agents that act on someone's behalf: a TypeScript library (Node 20+) that checks tool calls before they run and replies before they're sent. Customer support and internal operations are the two shipped journeys. `src/` names no journey; its "done" word list (`claims.ts`) is still account vocabulary, which is why the procurement example adds a status claim kind (see README Limitations).

Three nouns (tools, checks, journeys), the agent verbs (`respond`, `review`, `approve`, `decline`, `forget`, `chat`), two commands (`test`, `snapshot`).

## Layout

- `src/index.ts`: public exports. `src/sim/simulator.ts` is also exported as `trust-layer-agent/sim`.
- `src/agent.ts`: `Agent` and the `respond()` loop: model turn, checks on actions and replies, session updates. Also `review()` (reply checks on a draft the app wrote) and `approve()` / `decline()` for actions a check parked.
- `src/chat.ts`: `agent.chat()` for trying an agent in the terminal.
- `src/tools.ts`: `read()` / `write()`, input validation, field-level visibility, bound inputs.
- `src/checks.ts`: the check type and result shape (allow, block, rewrite, handoff, approve), check context, check runner.
- `src/builtins.ts`: built-in checks (verified_first, yes_after_quote, no_unconfirmed_claims, handoff_after_failures, no_repeated_writes, no_invented_inputs; untrusted_text_is_data is structural, in the agent loop).
- `src/claims.ts`: deterministic claim extraction and matching, shared by no_unconfirmed_claims and the grader; `ClaimKind` for operator-defined kinds.
- `src/session.ts`: the session JSON (including `approvals`), `createSession()`, `loadSession()`, `forget()`.
- `src/journeys.ts`: journey YAML schema, validation and guardrails compiled to checks.
- `src/files.ts`: YAML parsing with positions, zod issues as file:line:col, listing files in named paths or directories.
- `src/privacy.ts`: personal-data patterns used by tool visibility and trace masking.
- `src/trace.ts`: the JSONL trace sink (masked by default).
- `src/store.ts`: the `SessionStore` contract (load/save with optimistic locking), `memoryStore()`, `withStore()` (the agent's verbs by session id), `StaleSession`.
- `src/stores/postgres.ts`: the Postgres store + trace sink over an app-supplied query function; exported as `trust-layer-agent/postgres`.
- `src/models/`: `types.ts` (the Model interface), `anthropic.ts`, `openai-compatible.ts`, `resolve.ts` ("provider:model" strings).
- `src/sim/`: `task.ts` (task files), `simulator.ts` (simulated user, stand-in tools, trials), `grade.ts` (deterministic grading).
- `src/cli.ts`: the `test` and `snapshot` commands.
- `test/`: vitest unit tests. `fake-model.ts` is a scripted Model (no network); `fixtures.ts` builds check contexts. `tsconfig.test.json` type-checks the tests in CI (`npm run typecheck`).
- `examples/refunds.js`: the 10-line quickstart. `examples/subscriptions/`: the support example (store, tools, journeys, policy, `sim/` suite and 22 tasks). `examples/procurement/`: the operations example (`fromUser`, an `approve()` check, claim kinds, `review()`; `sim/` with 4 tasks). `test/examples.test.ts` drives both with a scripted model; `vitest.config.ts` aliases `trust-layer-agent` to `src/` so the examples run against source in tests.
- `snapshots/`: pinned versions (committed): `v1`, `v2`, `v2.1-sonnet`, `v2.1-haiku`, `v3-sonnet`, `v3-haiku`, `v3-sonnet-regraded`, `v3-haiku-regraded` (v3 trials re-graded offline with the fixed grader), `v4-sonnet`, `v4-haiku`. `results/` and `traces/` are written at run time and gitignored.
- `docs/design.md`: the approved API design.

## Commands

Run everything from the repo root.

```sh
npm install
npm run build          # tsc -> dist/ (needed before the CLI, examples or smoke)
npm test               # unit tests, same as: npx vitest run (no network, no keys)
npm run smoke          # REAL model calls; builds first, needs keys in .env
```

Simulations cost real money. They need `ANTHROPIC_API_KEY` in `.env` (copy `.env.example`); the CLI loads `.env` from the current directory. Build first: the `trust-layer-agent` bin points to `dist/cli.js`.

```sh
npx trust-layer-agent test --suite examples/subscriptions/sim --k 4
npx trust-layer-agent test --suite examples/subscriptions/sim --k 4 --tasks usage-pack,change-fails
npx trust-layer-agent test --suite examples/subscriptions/sim --k 4 --against v4-sonnet --min-pass 1
npx trust-layer-agent snapshot --suite examples/subscriptions/sim --name v4
```

- `test` flags: `--suite <dir>` (a folder with `suite.js`), `--k` (trials per task, default 4), `--tasks a,b`, `--agent-model provider:model`, `--max-cost` (USD, default 10; the run stops there), `--min-pass` (overall pass^k required, 0 to 1, default 1), `--against <name>` (the snapshot to diff against; default the newest in `snapshots/`). It prints a cost estimate first, then pass^k per task and the diff, and writes `results/<timestamp>.json`.
- Exit codes: 0 pass; 1 when pass^k is below `--min-pass` or a task flipped pass→fail against the snapshot; 2 on errors (including an unknown `--against` name, which fails before any model call).
- Report pass^k with trial counts (passing trials / total), not a bare percentage.
- `snapshot` needs `--suite` and `--name`. It pins the newest result to `snapshots/<name>.json` and refuses if the configuration changed since that run.
- `node dist/cli.js ...` works the same as `npx trust-layer-agent ...`.
- Never run `test`, `smoke` or the examples without the user's go-ahead: each makes paid API calls.

## Hard constraints

- Runtime dependencies: `zod` and `yaml` only. No model provider SDKs; adapters call HTTP APIs with `fetch`.
- Logic lines (non-blank, non-comment) have two caps: the library (`src/` without `src/sim/` and `src/cli.ts`) stays under 1,300 (1,209 today); the simulator and CLI stay under 450 (395 today). Count with:
  `cat $(ls src/*.ts src/models/*.ts src/stores/*.ts | grep -v cli.ts) | grep -Ev '^\s*($|//|/?\*)' | wc -l`
  `cat src/cli.ts src/sim/*.ts | grep -Ev '^\s*($|//|/?\*)' | wc -l`
- Node 20+. ESM only. Published as compiled JavaScript with `.d.ts` types, so plain-JS apps import it with no build step.

## Conventions

- Checks are deterministic code. Built-ins never call a model. A model-backed check would be a custom check an operator writes; the library ships none.
- No prices or other business values hardcoded in `src/`. They come from tools.
- Vendor-neutral naming in code, examples and sample data. No real company or product names; the examples are a fictional subscription app and a fictional purchasing desk.
- Every check change needs tests: add rows to the tables in `test/claims.test.ts` or `test/builtins.test.ts`. A change that lets more through also adds attack rows that must still be blocked.
- Measure behavior changes with `test --against <snapshot>`; keep behavior-neutral fixes separate from behavior changes. Re-baseline after changing the grader.
- Never weaken a simulation task to make it pass. Fix tools, checks or journeys instead, then rerun `test` and take a new snapshot.
- Extension happens only through tools, checks, journeys, model adapters and session stores. If an app use case needs a core change, the interface is wrong: fix the interface, not the app.
- Keep code small and readable, and match the surrounding style.
- Spec changes go in SPEC.md in the same change as the code, with a CHANGELOG.md entry under `[Unreleased]`.

## More

- [README.md](README.md): what it is, quickstart, the two examples. Measurements live in docs/results.md and plans in docs/roadmap.md; the README carries nothing that goes stale.
- [SPEC.md](SPEC.md): the language-neutral spec (journey schema, check results, session JSON, task format).
- [docs/design.md](docs/design.md): the approved API design. Where it and the code disagree, the code is current.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, CI, the rules above and the pull request checklist.
- [SECURITY.md](SECURITY.md): how to report a check bypass or data leak privately.
- [CHANGELOG.md](CHANGELOG.md): changes per version.
- [docs/how-it-was-built.md](docs/how-it-was-built.md): build log: timeline, decisions, the improvement loop, costs.
