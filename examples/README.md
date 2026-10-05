# Examples

All of these call a real model and need `ANTHROPIC_API_KEY` in `.env` at the repository root. Run `npm install` first (it builds the package).

| File | What it shows |
|---|---|
| [refunds.js](refunds.js) | The ten-line quickstart: one read tool, one write tool, `chat()` in the terminal. |
| [subscriptions/chat.js](subscriptions/chat.js) | Chat with the full subscription agent: tools, journeys, policy and every built-in check, shown inline. |
| [subscriptions/demo.js](subscriptions/demo.js) | A scripted customer through `respond()`, printed in the same teaching view. |
| [subscriptions/sim/](subscriptions/sim/) | The simulation suite: 22 tasks, stand-ins over a seeded store. Run with `npx trust-layer-agent test --suite examples/subscriptions/sim`. |

## Demo toggles (subscriptions/chat.js)

| Variable | Values | Effect |
|---|---|---|
| `CHANGE_PLAN_OUTCOME` | `fail` | `change_plan` fails with a known error (`billing_unavailable`). `FAIL_CHANGE_PLAN=1` means the same. |
| | `timeout` | `change_plan` applies the change, then times out with an unknown outcome. Watch for `· get_account (auto re-check) → ok`. |
| | `pending` | `change_plan` is accepted but not applied yet (`status: "pending"`); "done" wording is blocked. |
| `AGENT_MODEL` | `sonnet` (default), `haiku` | Which model plays the agent: `anthropic:claude-sonnet-5-5` or `anthropic:claude-haiku-4-5-20251001`. |

The active model and outcome are printed on startup. Examples:

```sh
CHANGE_PLAN_OUTCOME=timeout AGENT_MODEL=haiku node --env-file=.env examples/subscriptions/chat.js
CHANGE_PLAN_OUTCOME=fail node --env-file=.env examples/subscriptions/chat.js
```

`TRUST_LAYER_CHECKS=off` (read by subscriptions/agent.js) turns every built-in check off and strips the journey guardrails, keeping all prompt text, for comparing rules in a prompt with checks in code.
