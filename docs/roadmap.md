# Roadmap

What is planned, in rough order. Items move here from issues and pull-request discussions; the README stays descriptive of what exists.


1. Fit and eligibility decisions in tool output, with the write gated on them: for example, a quote returns `fitsUsage`, and a check blocks `change_plan` on a quote that doesn't fit.
2. A Python port, following [SPEC.md](SPEC.md).
3. Streaming. The trade-off: words would appear before they're checked.
4. More model adapters.
5. Optional small-model reply review, off by default, on top of the deterministic checks.
6. A cross-check on an external benchmark.
