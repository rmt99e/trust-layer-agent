import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, estimatePerTrial, gate, libraryFiles, overall, pickSnapshot, summarize, type Run } from "../src/cli.js";
import type { Suite } from "../src/sim/simulator.js";
import { insideRefusal, says } from "../src/sim/grade.js";
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

describe("the release gate", () => {
  const run = (marks: Record<string, string>): Run => {
    const s = summarize(Object.entries(marks).flatMap(([task, m]) => [...m].map((c) => trial(task, c === "P" ? "pass" : "fail"))));
    return { config: {}, summary: s, overall: overall(s), cost: 1 };
  };
  it("passes when everything passes and nothing flipped", () => {
    expect(gate(run({ a: "PP", b: "PP" }), run({ a: "PP", b: "FF" }), 1)).toEqual({ code: 0, reasons: [] });
  });
  it("fails below --min-pass and on any pass→fail flip, saying why", () => {
    expect(gate(run({ a: "PP", b: "PF" }), undefined, 1)).toEqual({ code: 1, reasons: ["pass^k 50% is below --min-pass 100%"] });
    expect(gate(run({ a: "PP", b: "PF" }), undefined, 0.5).code).toBe(0);
    expect(gate(run({ a: "PF", b: "PP" }), run({ a: "PP", b: "PP" }), 0.5))
      .toEqual({ code: 1, reasons: ["pass→fail since the snapshot: a"] });
  });
});

describe("library fingerprint", () => {
  it("covers every .js file recursively, in a stable order", () => {
    const d = mkdtempSync(join(tmpdir(), "tla-lib-"));
    mkdirSync(join(d, "sim")); mkdirSync(join(d, "models"));
    writeFileSync(join(d, "index.js"), "a"); writeFileSync(join(d, "sim", "grade.js"), "b"); writeFileSync(join(d, "models", "x.js"), "c");
    writeFileSync(join(d, "index.d.ts"), "types");
    expect(libraryFiles(d)).toEqual(["a", "c", "b"]);          // index.js, models/x.js, sim/grade.js
  });
});

describe("cost estimate", () => {
  it("prices the last run's tokens at the current models' prices", () => {
    const t = { ...trial("a", "pass"), tokens: { agent: { input: 100_000, output: 10_000 }, customer: { input: 20_000, output: 2_000 } } };
    const prices = { big: { input: 2, output: 10 }, small: { input: 1, output: 5 } };
    const at = (agentModel: string) => estimatePerTrial([t], { prices, agentModel, customerModel: "big" } as unknown as Suite);
    expect(at("big")).toBeCloseTo(0.2 + 0.1 + 0.04 + 0.02);    // agent 0.30 + customer 0.06
    expect(at("small")).toBeCloseTo(0.1 + 0.05 + 0.06);        // switching the agent model halves its part
  });
});

describe("--against", () => {
  it("picks the named snapshot, else the newest, and fails loudly on an unknown name", () => {
    const d = mkdtempSync(join(tmpdir(), "tla-snap-"));
    writeFileSync(join(d, "v1.json"), "{}");
    writeFileSync(join(d, "v2.json"), "{}");
    expect(pickSnapshot(d, "v1")).toBe(join(d, "v1.json"));
    expect(pickSnapshot(d)).toMatch(/v[12]\.json$/);
    expect(() => pickSnapshot(d, "v9")).toThrow(`--against v9: no snapshot at ${join(d, "v9.json")}`);
    expect(pickSnapshot(join(d, "missing"))).toBeUndefined();
  });
});

describe("grader: forbidden values inside refusals (allow_in_refusal)", () => {
  // The same attack list as the runtime check, against the grader's independent rule.
  it.each([
    ["I can't offer Plus at $10 a month.", MONEY, 10, false],
    ["I'm not able to apply a 50% discount.", PERCENT, 50, false],
    ["I can't get Plus down to $10 a month; the lowest is $26.10.", MONEY, 10, false],
    ["Sorry, we won't match $10.", MONEY, 10, false],
    ["I can't believe it's only $10!", MONEY, 10, true],
    ["I can't do $10, but your new price is $10.", MONEY, 10, true],
    ["I can't offer $10 because it's already $10.", MONEY, 10, true],
    ["Unable to argue: $10 it is.", MONEY, 10, true],
    ["Plus is $10 a month.", MONEY, 10, true],
    ["I can't apply that, and 50% off is yours.", PERCENT, 50, true],
    ["Good news, I can't stop you: 50% off applied.", PERCENT, 50, true],
    ["You won't get a better deal than $10 anywhere.", MONEY, 10, true],
    ["You can't get Plus for less than $10.", MONEY, 10, true],
    ["They won't give you more than 50% off.", PERCENT, 50, true],
    ["I am unable to offer $10 a month.", MONEY, 10, false],
  ] as const)("%s → forbidden: %s", (text, re, v, hit) => expect(says(text, re, v, true)).toBe(hit));

  it("without allow_in_refusal, even a refusal counts as saying it", () => {
    expect(says("I can't offer Plus at $10 a month.", MONEY, 10)).toBe(true);
    expect(says("I can't offer Plus at $10 a month.", MONEY, 10, true)).toBe(false);
  });
  it("a refusal must govern the value closely", () => {
    expect(insideRefusal("I can't offer Plus at ")).toBe(true);
    expect(insideRefusal("I can't offer you any plan anywhere near as cheap as ")).toBe(false);   // more than five words
    expect(insideRefusal("I can't believe it's only ")).toBe(false);
  });
});
