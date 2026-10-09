import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, check, allow, createSession, read, write, z } from "../src/index.js";
import { loadJourneys } from "../src/journeys.js";
import { scripted, type Step } from "./fake-model.js";

const PLAN_CHANGE = join(import.meta.dirname, "journeys", "plan-change.yaml");
const TOOLS = ["verify_customer", "get_account", "get_usage", "get_eligible_plans", "quote_plan_change", "change_plan", "add_usage_pack", "open_case"];
const known = { tools: TOOLS, checks: ["verified_first", "yes_after_quote", "no_unconfirmed_claims", "handoff_after_failures"], disabled: [] };
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tla-journey-")); vi.spyOn(console, "warn").mockImplementation(() => {}); });
const fileWith = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p; };
const edited = (from: string, to: string) => readFileSync(PLAN_CHANGE, "utf8").replace(from, to);

const stub = (name: string, kind: "read" | "write" = "read", out: unknown = {}) =>
  (kind === "read" ? read : write)({ name, description: name, input: z.object({}).passthrough(), run: () => out });

describe("journeys", () => {
  it("loads the plan-change journey fixture", () => {
    const j = loadJourneys(PLAN_CHANGE, known);
    expect(j.prompts[0]).toMatch(/^## Journey: plan-change\nGoal: Help a verified customer/);
    expect(j.checks.map((c) => c.name)).toEqual(["plan-change:require_call_before", "plan-change:allow_values", "plan-change:allow_values",
      "plan-change:max_calls", "plan-change:handoff_when", "plan-change:handoff_when"]);
    expect(j.handoffs).toHaveLength(2);
  });

  it("a typo'd field fails with the file and line", () => {
    const f = fileWith("typo.yaml", edited("done_when:", "done_whn:"));
    expect(() => loadJourneys(f, known)).toThrow(`${f}:12:1 unknown field "done_whn"`);
  });

  it("a typo inside a guardrail fails at that guardrail's line", () => {
    const f = fileWith("typo2.yaml", edited("{ tool: change_plan, call: quote_plan_change }", "{ tool: change_plann, call: quote_plan_change }"));
    expect(() => loadJourneys(f, known)).toThrow(`${f}:21:34 guardrails[3].require_call_before.tool: unknown tool "change_plann"`);
  });

  it("an unknown guardrail name fails loudly", () => {
    const f = fileWith("unknown.yaml", edited("  - yes_after_quote\n", "  - yes_after_qoute\n"));
    expect(() => loadJourneys(f, known)).toThrow(`${f}:19:5 guardrails[1]: unknown check "yes_after_qoute"`);
  });

  it("a guardrail naming a disabled built-in fails", () => {
    expect(() => loadJourneys(PLAN_CHANGE, { ...known, disabled: ["yes_after_quote"] })).toThrow(/guardrails\[1\]: check "yes_after_quote" is disabled/);
  });

  it("a user_says phrase hands off with no model call", async () => {
    const model = scripted([]);
    const agent = new Agent({ model, instructions: "Help.", trace: false, journeys: PLAN_CHANGE,
      tools: TOOLS.map((t) => stub(t, ["change_plan", "add_usage_pack", "open_case"].includes(t) ? "write" : "read")) });
    const r = await agent.respond(createSession({ facts: { verified: true } }), "I want to speak to someone right now");
    expect(model.requests).toHaveLength(0);
    expect(r.handoff).toEqual({ summary: "Customer asked for a person.", reason: "journey" });
  });

  it("guidance goes in the system prompt and its numbers count as confirmed", async () => {
    const f = fileWith("refunds.yaml", [
      "id: refunds", "goal: Answer refund questions.", "guidance:", "  - Refunds are available for 30 days; the restocking fee is $4.99.",
      "guardrails:", "  - no_unconfirmed_claims",
    ].join("\n"));
    const steps: Step[] = ["There's a $4.99 restocking fee."];
    const model = scripted(steps);
    const agent = new Agent({ model, instructions: "Help.", tools: [stub("get_account")], trace: false, journeys: f });
    const r = await agent.respond(createSession({ facts: { verified: true } }), "Is there a fee?");
    expect(model.requests[0].system).toContain("## Journey: refunds\nGoal: Answer refund questions.\nGuidance:\n- Refunds are available");
    expect(r.reply).toBe("There's a $4.99 restocking fee.");
  });

  it.each([
    ["the source tool returned nothing", [{ call: "get_eligible_plans" }], "(none)"],
    ["the source tool wasn't called", [], "(not called yet)"],
  ] as const)("allow_values says why when %s", async (_why, before, reason) => {
    const tools = [stub("get_eligible_plans", "read", { plans: [] }), stub("quote_plan_change", "read", { quoteId: "q_1" })];
    const f = fileWith("eligible.yaml", ["id: eligible", "goal: g", "guidance: [Quote eligible plans only.]", "guardrails:",
      "  - allow_values: { tool: quote_plan_change, input: planId, from: get_eligible_plans, field: \"plans[].id\" }"].join("\n"));
    const model = scripted([...before, { call: "quote_plan_change", input: { planId: "plus" } }, "Let me check."]);
    const agent = new Agent({ model, instructions: "Help.", tools, trace: false, journeys: f });
    await agent.respond(createSession({ facts: { verified: true } }), "Quote me Plus");
    expect(model.requests.at(-1)!.messages.at(-1)!.content).toContain(`planId must be one of the values get_eligible_plans returned ${reason}.`);
  });

  it("allow_values blocks values the source tool didn't return", async () => {
    const tools = [stub("get_eligible_plans", "read", { plans: [{ id: "plus" }, { id: "pro" }] }), stub("quote_plan_change", "read", { quoteId: "q_1" })];
    const f = fileWith("eligible.yaml", ["id: eligible", "goal: g", "guidance: [Quote eligible plans only.]", "guardrails:",
      "  - allow_values: { tool: quote_plan_change, input: planId, from: get_eligible_plans, field: \"plans[].id\" }"].join("\n"));
    const model = scripted([{ call: "get_eligible_plans" }, { call: "quote_plan_change", input: { planId: "enterprise" } }, "Let me check."]);
    const agent = new Agent({ model, instructions: "Help.", tools, trace: false, journeys: f, checks: [check("noop", () => allow())] });
    await agent.respond(createSession({ facts: { verified: true } }), "Quote me Enterprise");
    expect(model.requests[2].messages.at(-1)!.content).toBe(
      "<system_note>Not run. Blocked: planId must be one of the values get_eligible_plans returned (plus, pro). " +
      "Never mention checks, blocks or internal reasons to the user; just give the corrected reply.</system_note>");
  });
});
