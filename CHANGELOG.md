# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from its first release.

`v1` and `v2` are internal milestones (git tags), not npm releases. The first npm release will be **0.1.0**.

## [Unreleased]

### Added

- Docs: README, SPEC.md (language-neutral spec), AGENTS.md, llms.txt, copy-paste prompts for adding the trust layer to a JS/TS app and for porting it to another language, this changelog, and a build log ([docs/how-it-was-built.md](docs/how-it-was-built.md)).
- Subscriptions example: a checks-off mode for comparison runs. `TRUST_LAYER_CHECKS=off` keeps every prompt (instructions, journey guidance, knowledge) but turns off the built-in checks and strips journey guardrails, so the rules exist only as prompt text. Bind injection and field visibility stay on.

### Changed

- docs/design.md now opens with a note that SPEC.md describes current behavior.

### Fixed

- Clearer block reason when an `allow_values` guardrail blocks an action.

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

Internal milestone: the runtime, both model adapters and the subscriptions example. The runtime is tested with a scripted fake model; the adapters were smoke-tested with real calls.

### Added

- Tools: `read()` and `write()` with explicit names, input schemas, `bind` injection from session facts, field-level `visible` lists with personal-data fields hidden by default, `records` applied only on success, `confirm` for quote-backed writes, and `ToolError`.
- Checks: one function type returning allow, block, rewrite or handoff, guarding both actions and replies. Built-ins on by default: `verified_first`, `yes_after_quote`, `no_unconfirmed_claims`, `untrusted_text_is_data` (structural fencing of customer and tool text), `handoff_after_failures`.
- Session as plain JSON with facts, commitments, messages and tool results; `createSession()` and `forget()`.
- `agent.respond()` and `agent.chat()`; JSONL traces with emails, phone numbers and addresses masked.
- Journeys in YAML with enforced guardrails and prompt-only guidance, validated on load with file and line in errors.
- Model adapters for `anthropic` and `openai-compatible`, using plain `fetch`.
- The subscriptions example: the 10-line refunds quickstart and the full plan-change agent (verification, usage, eligible plans, quotes, plan change, refunds, usage packs, cases and handoff) over a seeded in-memory store.

[Unreleased]: https://github.com/OWNER/trust-layer-agent/compare/v2...HEAD
[v2]: https://github.com/OWNER/trust-layer-agent/compare/v1...v2
[v1]: https://github.com/OWNER/trust-layer-agent/releases/tag/v1
