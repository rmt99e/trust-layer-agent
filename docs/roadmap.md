# Roadmap

What is planned, in rough order. Items move here from issues and pull-request discussions; the README stays descriptive of what exists.


1. Fit and eligibility decisions in tool output, with the write gated on them: for example, a quote returns `fitsUsage`, and a check blocks `change_plan` on a quote that doesn't fit.
2. A Python port, following [SPEC.md](SPEC.md).
3. Streaming. The trade-off: words would appear before they're checked.
4. More model adapters.
5. Optional small-model reply review, off by default, on top of the deterministic checks.
6. A cross-check on an external benchmark.

## Pre-1.0 naming decision

- The check result `approve(reason)` means "this needs a person's approval", while `agent.approve(session, id)` means "a person approved it". Same word, two directions. Rename the check helper (candidates: `needsApproval`, `park`) before the first npm release, since the wire key `approve` on `CheckResult` and in trace lines would change with it.
- `by` names three different things across the session: the tool on a `Commitment`, the check on an `Approval`, the person on a `Message`, while the person on an `Approval` is `decidedBy`. All are wire keys, so a rename is a schema change; decide it with the `approve` helper before 1.0.
