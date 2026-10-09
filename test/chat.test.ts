import { describe, expect, it, vi } from "vitest";
import { teachingView } from "../src/index.js";

describe("the teaching view", () => {
  it("prints one line per event kind", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    teachingView({ type: "tool", tool: "get_order", ok: true });
    teachingView({ type: "check", event: "action", tool: "refund", check: "big", result: { approve: "Over." } });
    teachingView({ type: "check", event: "reply", check: "claims", result: { block: "No." }, draft: "x" });
    teachingView({ type: "approval", decision: "approved", tool: "refund", ok: true });
    teachingView({ type: "review", result: { allow: true } });
    expect(log.mock.calls.map((c) => c[0])).toEqual(["   · get_order → ok", "   ⏸ parked refund  [big]  Over.", '   ✗ draft not sent  [claims]\n     draft:  "x"\n     reason: No.', "   ✓ approved refund → ok", "   review → ok"]);
    log.mockRestore();
  });
});

