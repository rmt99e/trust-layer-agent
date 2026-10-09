import { describe, expect, it } from "vitest";
import { createSession, forget, read, z, type SessionV1 } from "../src/index.js";
import { loadSession } from "../src/session.js";
import { runTool } from "../src/tools.js";

describe("session", () => {
  it("starts empty, versioned, with trusted facts from the app", () => {
    const s = createSession({ facts: { verified: true, accountId: "acc_1" } });
    expect(s).toMatchObject({ v: 2, rev: 0, status: "open", facts: { verified: true, accountId: "acc_1" },
      commitments: [], results: [], messages: [], approvals: [], failures: 0 });
    expect(s.id).toMatch(/^s_[0-9a-f]{12}$/);
  });

  it("loadSession upgrades a v1 session: the customer role becomes user, approvals is filled in, v becomes 2", () => {
    const { approvals, ...rest } = createSession();
    const old: SessionV1 = { ...rest, v: 1, messages: [{ role: "customer", text: "hi", turn: 1 }, { role: "agent", text: "hello", turn: 1 }] };
    const loaded = loadSession(old);
    expect(loaded).toMatchObject({ v: 2, approvals: [], messages: [{ role: "user", text: "hi", turn: 1 }, { role: "agent", text: "hello", turn: 1 }] });
    expect(loaded).not.toBe(old);
    expect(old.messages[0].role).toBe("customer");                                     // the stored copy is untouched
    expect(loadSession(createSession())).toMatchObject({ v: 2, approvals: [] });
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
    expect(f).toEqual({ v: 2, id: s.id, forgotten: true });
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
