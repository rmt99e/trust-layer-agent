# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x (once released) | Yes |
| Pre-release (current main) | Best effort |

## Reporting a vulnerability

Please report privately, not in a public issue. Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**.

Include:

- the version or commit you tested;
- a minimal reproduction: the tools, checks or journey involved, and the session or message sequence that triggers it;
- what got through (the reply, tool call or data) and what you expected to be blocked;
- a trace excerpt if useful, with personal data removed.

This is a small project maintained on a best-effort basis. We aim to acknowledge reports within a week and to fix confirmed issues in the next release, crediting you if you want.

## In scope

Bypasses of what the library claims to enforce in code, for example:

- a reply that states a price, date or "done" no tool returned and still passes `no_unconfirmed_claims`;
- any reply sent while a write's outcome is still unknown, or a write that runs again in the same turn after it succeeded or while its outcome is unknown or pending (`no_repeated_writes`);
- a write tool that runs without the required quote and yes (`yes_after_quote`), or account data returned before verification (`verified_first`);
- a model or customer overriding a bound tool input (bind injection);
- personal data reaching the model past field-level visibility, or reaching traces past masking;
- customer or tool text forging the fences or system notes so it is read as instructions.

## Out of scope

Model behavior that no check claims to cover: tone, wrong advice within allowed actions (including judgments such as "this plan fits your usage", which no check verifies yet), or a model ignoring prompt-only guidance. Issues in your own tools or data functions, and in model providers' APIs, belong with those projects.
