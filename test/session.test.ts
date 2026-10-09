import { describe, expect, it } from "vitest";
import { createSession, forget, read, z } from "../src/index.js";
import { loadSession } from "../src/session.js";
import { runTool } from "../src/tools.js";

describe("session", () => {
  it("starts empty, versioned, with trusted facts from the app", () => {
    const s = createSession({ facts: { verified: true, accountId: "acc_1" } });
    expect(s).toMatchObject({ v: 1, rev: 0, status: "open", facts: { verified: true, accountId: "acc_1" },
      commitments: [], results: [], messages: [], approvals: [], failures: 0 });
    expect(s.id).toMatch(/^s_[0-9a-f]{12}$/);
  });

  it("loadSession copies a session and fills in approvals for one stored before they existed", () => {
    const { approvals, ...old } = createSession();
    const loaded = loadSession(old as any);
    expect(loaded.approvals).toEqual([]);
    expect(loaded).not.toBe(old);
    expect(loadSession(createSession()).approvals).toEqual([]);
  });

  it("round-trips as plain JSON, including after a tool call", async () => {
    const tool = read({ name: "get_plan", description: "Plan.", input: z.object({}),
      records: () => ({ commitments: [{ type: "quote", id: "q_1", values: { monthlyPrice: 29 } }] }),
      run: () => ({ name: "Plus" }) });
    const { session } = await runTool(tool, {}, createSession({ facts: { verified: true } }));
    expect(JSON.parse(JSON.stringify(session))).toEqual(session);
    const fresh = createSession();
    expect(JSON.parse(JSON.stringify(fresh))).toEqual(fresh);
  });

  it("forget keeps only the id", () => {
    const s = createSession({ facts: { accountId: "acc_1" } });
    const f = forget(s);
    expect(f).toEqual({ v: 1, id: s.id, forgotten: true });
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });

  it("never mutates the session it was given", async () => {
    const tool = read({ name: "verify_customer", description: "Verify.", input: z.object({ pin: z.string() }),
      beforeVerification: true, verifies: true, records: () => ({ facts: { verified: true } }), run: () => ({ ok: true }) });
    const before = createSession();
    const snapshot = JSON.stringify(before);
    const { session } = await runTool(tool, { pin: "4417" }, before);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(session.facts.verified).toBe(true);
  });
});
