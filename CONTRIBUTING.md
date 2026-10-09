# Contributing

Thanks for helping. trust-layer-agent caps its logic lines: the library (checks, the agent loop, two model adapters, the store contract with its Postgres adapter) stays under 1,300; the simulator and CLI stay under 450. A change that adds a feature near a cap needs a trim elsewhere first.

Be respectful: assume good faith, keep feedback about the work, and help newcomers.

## Setup

Node 20.12 or later. Fork the repository on GitHub and clone your fork, then:

```sh
npm install
npm run build    # tsc -> dist/ (needed before the CLI and the examples)
npm test         # vitest unit tests: no network, no API keys
npm run typecheck   # the tests and vitest config under the strict compiler
```

`npm install` runs the `prepare` script, which builds `dist/`. That is what lets `npm install github:…` ship compiled JavaScript, and it means a compile error in `src/` makes a fresh install fail; run `npm run build` to see the error.

## What CI runs

Every push and pull request runs `npm ci`, `npm test`, `npm run typecheck` (the tests under the strict compiler), `npm run build` and `npm pack --dry-run` on Node 20, 22 and 24 ([.github/workflows/ci.yml](.github/workflows/ci.yml)). CI uses no secrets and makes no model calls.

## Simulations (paid, optional, never in CI)

`test` runs simulated users against real models, so it costs real money. You don't need it for most changes; maintainers can run it on a pull request that changes behavior.

1. Copy `.env.example` to `.env` and add `ANTHROPIC_API_KEY` by hand. Never commit `.env`.
2. Build, then run a few tasks with a low spend cap first:

   ```sh
   npm run build
   npx trust-layer-agent test --suite examples/subscriptions/sim --k 2 --tasks usage-pack --max-cost 1
   ```

3. Read the cost estimate the command prints before it starts. The run stops at `--max-cost` (USD, default 10).
4. Report pass^k with trial counts, for example "pass^4 17/18 tasks (70/72 trials)", not a bare percentage.

Exit codes: 0 pass; 1 when pass^k is below `--min-pass` or a task flipped pass to fail against the snapshot; 2 on errors. Runs write `results/` and `traces/`, which are gitignored.

## Rules

- **Attack tests for every relaxation.** Any change that lets more text or actions through (a new phrasing that counts as a yes, a claim pattern that no longer blocks) must add attack rows, cases that must still be blocked, alongside the newly allowed rows in `test/claims.test.ts` or `test/builtins.test.ts`.
- **Never weaken a simulation task to make it pass.** Fix tools, checks or journeys instead.
- **Measure behavior changes against a snapshot.** Run `test --against <snapshot>` and include the diff. Keep behavior-neutral fixes (refactors, messages, docs) in separate pull requests from behavior changes, so each diff means one thing.
- **Re-baseline after changing the grader.** A grader change moves every score; run the old snapshot's configuration again under the new grader before comparing.
- **Checks are deterministic.** Built-in checks never call a model. A model-backed check would be a custom check an operator writes; the library ships none.
- **No prices or business values in `src/`.** They come from tools.
- **Vendor-neutral names.** No real company or product names in code, examples or sample data.
- **Extension only through tools, checks, journeys, model adapters and session stores.** If a use case needs a core change, the interface is wrong; open an issue first. Things that don't fit go in docs/roadmap.md.
- **Logic-line caps.** The library (`src/` without `src/sim/` and `src/cli.ts`) stays under 1,300 non-blank, non-comment lines; the simulator and CLI under 450. Count with:
  `cat $(ls src/*.ts src/models/*.ts src/stores/*.ts | grep -v cli.ts) | grep -Ev '^\s*($|//|/?\*)' | wc -l`
  `cat src/cli.ts src/sim/*.ts | grep -Ev '^\s*($|//|/?\*)' | wc -l`
- Runtime dependencies stay `zod` and `yaml` only. Adapters use `fetch`, no provider SDKs.

## Pull request checklist

- [ ] `npm test` and `npm run build` pass.
- [ ] New or changed checks have test rows; relaxations have attack rows.
- [ ] Behavior changes include a `test --against <snapshot>` diff with trial counts (or say a maintainer should run it).
- [ ] SPEC.md updated if behavior in the spec changed.
- [ ] A `CHANGELOG.md` entry under `[Unreleased]`.
- [ ] Logic-line counts still under their caps (library 1,300; simulator and CLI 450).
- [ ] No secrets, personal data or real company names in code, fixtures or traces.

## Where docs live

- [README.md](README.md): what it is, quickstart, the two examples. Keep measurements, counts and plans out of it: results go in docs/results.md, plans in docs/roadmap.md.
- [SPEC.md](SPEC.md): normative and language-neutral. Update it in the same pull request as any behavior change it covers.
- [CHANGELOG.md](CHANGELOG.md): add an entry under `[Unreleased]`.
- [AGENTS.md](AGENTS.md): layout, commands and conventions for coding agents.
- [docs/design.md](docs/design.md): the original design's decisions, kept for history. [docs/how-it-was-built.md](docs/how-it-was-built.md): the build log.

Security issues: don't open a public issue. See [SECURITY.md](SECURITY.md).
