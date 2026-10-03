# AGENTS.md

Notes for coding agents working on this repo. For using the package in an app, read README.md.

trust-layer-agent is a small trust layer for customer-facing agents: tools gated by checks in code, replies that can't claim what no tool confirmed, customer data shown to the model only on a need-to-know basis, and releases that must pass simulations first.

Core idea: the model chooses the words; code decides what's allowed. Three nouns (tools, checks, journeys), one verb (`respond`), two commands (`test`, `snapshot`).

## Layout

- `src/index.ts`: public exports. `src/sim/simulator.ts` is also exported as `trust-layer-agent/sim`.
- `src/agent.ts`: `Agent` and the `respond()` loop: model turn, checks on actions and replies, session updates.
- `src/chat.ts`: `agent.chat()` for trying an agent in the terminal.
- `src/tools.ts`: `read()` / `write()`, input validation, field-level visibility, bound inputs.
- `src/checks.ts`: the check type and result shape (allow, block, rewrite, handoff), check context, check runner.
- `src/builtins.ts`: built-in checks (verified_first, yes_after_quote, no_unconfirmed_claims, handoff_after_failures).
- `src/claims.ts`: deterministic claim extraction and matching, shared by no_unconfirmed_claims and the grader.
- `src/session.ts`: the session JSON, `createSession()`, `forget()`.
- `src/journeys.ts`: journey YAML loading, validation with file and line, guardrails compiled to checks.
- `src/privacy.ts`: personal-data patterns used by tool visibility and trace masking.
- `src/trace.ts`: the JSONL trace sink (masked by default).
- `src/models/`: `types.ts` (the Model interface), `anthropic.ts`, `openai-compatible.ts`, `resolve.ts` ("provider:model" strings).
- `src/sim/`: `task.ts` (task files), `simulator.ts` (simulated customer, stand-in tools, trials), `grade.ts` (deterministic grading).
- `src/cli.ts`: the `test` and `snapshot` commands.
- `test/`: vitest unit tests. `fake-model.ts` is a scripted Model (no network); `fixtures.ts` builds check contexts.
- `examples/refunds.js`: the 10-line quickstart. `examples/subscriptions/`: the full example (store, tools, journeys, policy, `sim/` suite and tasks).
- `snapshots/`: pinned versions (committed). `results/` and `traces/` are written at run time and gitignored.
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
npx trust-layer-agent snapshot --suite examples/subscriptions/sim --name v3
```

- `test` flags: `--suite <dir>` (a folder with `suite.js`), `--k` (trials per task, default 4), `--tasks a,b`, `--agent-model provider:model`, `--max-cost` (USD, default 10; the run stops there). It prints a cost estimate first, then pass^k per task and a diff against the newest snapshot, and writes `results/<timestamp>.json`.
- `snapshot` needs `--suite` and `--name`. It pins the newest result to `snapshots/<name>.json` and refuses if the configuration changed since that run.
- `node dist/cli.js ...` works the same as `npx trust-layer-agent ...`.
- Never run `test`, `smoke` or the examples without the user's go-ahead: each makes paid API calls.

## Hard constraints

- Runtime dependencies: `zod` and `yaml` only. No model provider SDKs; adapters call HTTP APIs with `fetch`.
- Logic lines in `src/` stay under 1,300 (non-blank, non-comment; about 1,140 today). Count with:
  `cat src/*.ts src/*/*.ts | grep -Ev '^\s*($|//|/?\*)' | wc -l`
- Node 20+. ESM only. Published as compiled JavaScript with `.d.ts` types, so plain-JS apps import it with no build step.

## Conventions

- Checks are deterministic code. Built-ins never call a model; small-model reply review is an optional extra check, off by default.
- No prices or other business values hardcoded in `src/`. They come from tools.
- Vendor-neutral naming in code, examples and sample data. No real company or product names; the example is a fictional subscription app.
- Every check change needs tests: add rows to the tables in `test/claims.test.ts` or `test/builtins.test.ts`.
- Never weaken a simulation task to make it pass. Fix tools, checks or journeys instead, then rerun `test` and take a new snapshot.
- Extension happens only through tools, checks, journeys and model adapters. If an app use case needs a core change, the interface is wrong: fix the interface, not the app.
- Keep code small and readable, and match the surrounding style.
- Spec changes go in SPEC.md in the same change as the code.

## More

- [README.md](README.md): what it is, quickstart, the example.
- [SPEC.md](SPEC.md): the language-neutral spec (journey schema, check results, session JSON, task format).
- [docs/design.md](docs/design.md): the approved API design. Where it and the code disagree, the code is current.
