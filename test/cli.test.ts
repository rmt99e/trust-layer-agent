import { describe, expect, it } from "vitest";
import { compare, overall, summarize, type Run } from "../src/cli.js";
import { says } from "../src/sim/grade.js";
import type { Trial } from "../src/sim/simulator.js";

const MONEY = /[$€£]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:dollars?|usd|euros?|eur)\b/gi, PERCENT = /(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi;
const trial = (task: string, status: Trial["status"], friction = 0, cost = 0.1): Trial =>
  ({ task, trial: 1, status, friction, cost, turns: 1, transcript: [], events: [] });

describe("forbidden_claims matcher", () => {
  it.each([
    ["Plus for $10 a month", MONEY, 10, true], ["that's 10 dollars", MONEY, 10, true], ["$1,019.90 total", MONEY, 1019.9, true],
    ["a 10% discount", MONEY, 10, false], ["$100 a month", MONEY, 10, false], ["I can't do 50% off", PERCENT, 50, true],
    ["save 50 percent", PERCENT, 50, true], ["save $50", PERCENT, 50, false], ["$19.50 a month", MONEY, 19.5, true],
  ] as const)("%s → %s %s: %s", (text, re, v, hit) => expect(says(text, re, v)).toBe(hit));
});

describe("summary and friction", () => {
  it("counts pass^k over scored trials, excludes infra, and averages friction per trial", () => {
    const s = summarize([trial("a", "pass", 2), trial("a", "pass", 0), trial("a", "infra", 0), trial("b", "pass"), trial("b", "fail", 3)]);
    expect(s.a).toMatchObject({ trials: "PPI", passK: true, pass1: 1, infra: 1 });
    expect(s.a.friction).toBeCloseTo(2 / 3);
    expect(s.b).toMatchObject({ trials: "PF", passK: false, pass1: 0.5, friction: 1.5 });
    expect(overall(s)).toBe(0.5);
    expect(summarize([trial("c", "infra")]).c.passK).toBe(false);          // all-infra isn't a pass
  });
});

describe("diff against a snapshot", () => {
  const config = { agentModel: "anthropic:m", customerModel: "anthropic:m", journeys: "aaa" };
  const run = (marks: Record<string, string>, over: Partial<Run> = {}): Run => {
    const s = summarize(Object.entries(marks).flatMap(([task, m]) => [...m].map((c) => trial(task, c === "P" ? "pass" : "fail", c === "P" ? 0 : 1))));
    return { config, summary: s, overall: overall(s), cost: 1, ...over };
  };
  it("reports flips in both directions and friction changes", () => {
    const lines = compare({ ...run({ a: "PP", b: "PF", c: "PP" }), name: "v1" }, run({ a: "PF", b: "PP", c: "PP", d: "PP" }));
    expect(lines).toContain("  ↓ pass→fail  a");
    expect(lines).toContain("  ↑ fail→pass  b");
    expect(lines).toContain("  + d: new task");
    expect(lines).toContain("  a: friction 0.00 → 0.50 per trial");
    expect(lines.at(-1)).toBe("  overall pass^k 67% → 75%; cost $1.00 → $1.00");
  });
  it("warns when pinned configuration differs", () => {
    const lines = compare({ ...run({ a: "PP" }), name: "v1" }, run({ a: "PP" }, { config: { ...config, customerModel: "openai-compatible:x", journeys: "bbb" } }));
    expect(lines.slice(0, 2)).toEqual(['⚠️  config differs from snapshot "v1": customerModel', '⚠️  config differs from snapshot "v1": journeys']);
  });
});
