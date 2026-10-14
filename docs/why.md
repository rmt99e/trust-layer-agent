# Why trust-layer-agent exists

You build an agent on a model. You give it tools that read an account, quote a change, place an order, refund an invoice. The model handles the conversation well. It does not reliably know what those tools did, what the user said or what the user agreed to, and instructions cannot make it know.

The library keeps those facts in the session and puts the rules that read them in code. What follows is what that gives you, in the library's own order: gate, check, measure. The quoted lines are the library's own block reasons, each pinned by an exact assertion in the test suite. The reference for each is in the [README](../README.md).

## Consent before a write

A write runs only after the agent has replied and the user's latest message is a clear yes, unless the tool opts out with `confirm: false`. A write tied to a quote also needs that quote to exist in this session, to have been shown in an earlier reply, and to be unused and unexpired; the quote is spent once. Details under [Checks](../README.md#checks).

> `Before change_plan, tell the user exactly what will happen and wait for a clear yes.`

## Inputs come from the user

`bind` fills a tool field from a session fact and overwrites whatever the model sent, so an account id is never the model's to choose. `fromUser` requires a field's values to appear in the user's own messages or a fact, so a search runs on what was asked for. See [Tools](../README.md#tools).

> `The user never said "office seating" (query in search_catalog). Use only values the user gave, or ask them.`

## A person can take the decision

A check can return `approve(reason)`. The call is parked on the session, the model is told it is requested rather than done, and the conversation continues. Your app shows the parked action to a person and calls `agent.approve()` or `agent.decline()`, naming who decided; the result, the decision, who made it and when all land in the session for the next turn and the audit trail. A check can also return `handoff(summary)` to end the turn, and a journey's `handoff_when` hands off on a phrase or a fact before the model is called, or on a tool result or error as soon as it lands. See [Checks](../README.md#checks).

## What the model can see

A tool lists the output fields the model may see; without a list, fields named like personal data are hidden and personal data in other strings is masked. User messages and tool output reach the model fenced as data with angle brackets escaped, and anything a system note quotes from them is escaped too. Trace lines are masked before they reach a sink unless the sink sets `mask: false`. See [Tools](../README.md#tools).

## Replies that match the record

Prices, percentages, dates and "done" wording in a draft must appear in a successful tool result or a commitment from this session, or in your instructions, journeys and knowledge files. Values match by kind, so a 10% discount does not confirm "$10". A write's outcome is tracked, so "done" needs a successful write and nothing goes out while an outcome is unknown. Claim kinds extend this to your own vocabulary; see [Checks](../README.md#checks).

> `Reply says "has been processed", but refund_order failed and hasn't succeeded since. Say what actually happened.`

## Your own messages are checked too

`agent.review(session, draft)` runs the reply checks on text the model did not write: a rendered template, a scheduled notice, an outbound email. It makes no model call and leaves the session unchanged. See [Checks](../README.md#checks).

## Measure the agent against simulated users

A simulator measures both. It plays scripted users against your agent, k times per task, grades every trial, and `snapshot` pins the result so a change can be diffed. See [Testing](../README.md#testing).
