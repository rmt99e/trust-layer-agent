# trust-layer-agent: the original design and its decisions

> Written before v1 and kept for history. [SPEC.md](../SPEC.md) describes current behavior; where they differ, SPEC.md is right.
> Since this was written: the party the agent talks to is the `user` (role `user`, fence `<user_message>`, guardrail `user_says`, suite field `userModel`, task block `user:`); sessions are schema v2 with `approvals`, timestamps and owned-session support; `review()`, `approve()`/`decline()`, `resume()`, `secret`, `fromUser`, claim kinds, `TurnFailed` and the store contract were added; the config file `trust-layer.config.js` never shipped (suites are `suite.js`); the line budget became two caps. The full API sections that used to live here were superseded by SPEC.md and removed; `git log -- docs/design.md` has them.

The model chooses the words; code decides what's allowed. Two parts of the original page still earn their place: the acceptance sketch that shaped `createSession({ facts })`, and the decisions that closed the open questions.

## 1. Acceptance check: plain-JS Express + Postgres

```js
// routes/support.js  (plain ESM, no build step)
import { createSession } from "trust-layer-agent";
import { agent } from "../agent.js";               // tools wrap the app's existing data functions
import { pool } from "../db.js";

export async function supportRoute(req, res) {
  const id = req.params.conversationId;
  const { rows } = await pool.query("select data from agent_sessions where id = $1", [id]);
  const session = rows[0]?.data ?? createSession({ facts: { verified: true, accountId: req.user.accountId } });
  const { reply, session: next, handoff } = await agent.respond(session, req.body.message);
  await pool.query(
    `insert into agent_sessions (id, data) values ($1, $2)
     on conflict (id) do update set data = excluded.data, updated_at = now()`, [id, next]);
  if (handoff) await notifySupport(id, handoff.summary);
  res.json({ reply, handedOff: Boolean(handoff) });
}
```

Writing this sketch changed the design in one place. A logged-in app already knows who the customer is, so `createSession({ facts })` was added (SPEC.md section 7): chat-based verification is only for anonymous channels. No core change is needed for the four target journeys ("which plan fits me", "where's my request", general product questions, "I'm in danger"): each is tools + journey YAML + simulation tasks, and "I'm in danger" (escalate to a person) is a `handoff_when: { user_says: [...] }` guardrail.

## 2. Decisions (formerly open questions)

1. **Default visibility.** If `visible` is omitted, fields that look like personal data (by name or by value: email, phone, address, dob/date of birth, ssn, card numbers) are hidden and everything else is visible. The constructor lists the hidden fields per tool. `strictVisibility: true` hides every field not listed.
2. **Customer-stated numbers.** They never count as confirmed. Only tool results, commitments and operator-authored text do. The block reason tells the model to rephrase.
3. **Affirmations.** An English phrase list in v0.1, configurable via `builtins: { yes_after_quote: { phrases } }`.
4. **The session holds `messages` and `results`,** the need-to-know context. The masked trace goes to a sink, not the session.
5. **Quickstart** uses the `read({ name, … })` object form and `model: openaiCompatible({ … })`.
6. **The example includes `verify_customer`** (read, `beforeVerification: true`, `verifies: true`).
7. **Concurrent messages.** The app does compare-and-set on `session.rev`; the library increments it.
8. **Stand-ins** are per suite, with per-task `inject_failures`.
9. **Line budget** is ≈1,090. Task validation stays.
10. **Relative dates** ("tomorrow") are date claims and need a tool-returned date this session.
