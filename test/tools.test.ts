import { describe, expect, it, vi } from "vitest";
import { createSession, read, ToolError, write, z } from "../src/index.js";
import { runTool, toolSpec, visibleOutput } from "../src/tools.js";

const verified = () => createSession({ facts: { verified: true, accountId: "acc_1" } });

const getInvoice = read({
  name: "get_invoice",
  description: "Look up one invoice on the customer's account.",
  input: z.object({ accountId: z.string(), invoiceId: z.string() }),
  bind: { accountId: "facts.accountId" },
  run: ({ accountId, invoiceId }) => ({ accountId, invoiceId, amount: 19.99 }),
});

describe("bind", () => {
  it("removes bound fields from the model-facing schema", () => {
    const spec = toolSpec(getInvoice);
    expect(spec.name).toBe("get_invoice");
    expect(Object.keys(spec.inputSchema.properties as object)).toEqual(["invoiceId"]);
    expect(spec.inputSchema.required).toEqual(["invoiceId"]);
  });

  it("injects bound fields from session facts, overriding anything the model sent", async () => {
    const { result } = await runTool(getInvoice, { invoiceId: "inv_9", accountId: "acc_EVIL" }, verified());
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ accountId: "acc_1", invoiceId: "inv_9", amount: 19.99 });
  });

  it("blocks the call when the bound fact is missing", async () => {
    const run = vi.fn();
    const tool = read({ ...getInvoice, run });
    const { result } = await runTool(tool, { invoiceId: "inv_9" }, createSession());
    expect(result.error?.code).toBe("missing_fact");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects bind fields that aren't in the schema", () => {
    expect(() => read({ ...getInvoice, bind: { customerId: "facts.customerId" } })).toThrow(/not in the input schema/);
  });
});

describe("visibility", () => {
  const account = {
    id: "acc_1", plan: { name: "Basic", price: 9 }, email: "dana@example.com", phone: "+1 415 555 0100",
    homeAddress: "12 Oak Street", dob: "1990-02-03", ssn: "123-45-6789", note: "reach me at dana@example.com",
    invoices: [{ id: "inv_1", amount: 9, cardNumber: "4111111111111111" }],
  };

  it("shows listed fields only", () => {
    const { value } = visibleOutput(account, ["id", "plan.name", "invoices[].amount"]);
    expect(value).toEqual({ id: "acc_1", plan: { name: "Basic" }, invoices: [{ amount: 9 }] });
  });

  it("by default hides fields with personal names and masks personal data inside other text", () => {
    const { value, hidden } = visibleOutput(account);
    expect(value).toEqual({ id: "acc_1", plan: { name: "Basic", price: 9 }, note: "reach me at [email]",
      invoices: [{ id: "inv_1", amount: 9 }] });
    expect(hidden.sort()).toEqual(["dob", "email", "homeAddress", "invoices[].cardNumber", "phone", "ssn"]);
  });

  it("masks phone, card, ssn and address inside free text, keeping dates and prices", () => {
    const { value } = visibleOutput({ memo: "Called +1 (415) 555-0100 on 2026-11-01 about $1,019.90; card 4111 1111 1111 1111, ssn 123-45-6789, lives at 12 Oak Street." });
    expect(value).toEqual({ memo: "Called [phone] on 2026-11-01 about $1,019.90; card [card], ssn [ssn], lives at [address]" });
  });

  it("strictVisibility hides everything unlisted", () => {
    expect(visibleOutput(account, undefined, true).value).toBeNull();
    expect(visibleOutput(account, ["id"], true).value).toEqual({ id: "acc_1" });
  });

  it("applies visibility to what runTool returns to the model", async () => {
    const tool = read({ name: "get_account", description: "Account.", input: z.object({}), visible: ["id"], run: () => account });
    expect((await runTool(tool, {}, verified())).result.output).toEqual({ id: "acc_1" });
  });
});

describe("records", () => {
  const quote = read({
    name: "quote_plan_change",
    description: "Quote a plan change.",
    input: z.object({ planId: z.string() }),
    records: (q: { quoteId: string; monthlyPrice: number }) => ({
      facts: { lastQuote: q.quoteId },
      commitments: [{ type: "quote", id: q.quoteId, values: { monthlyPrice: q.monthlyPrice } }],
    }),
    run: async ({ planId }) => {
      if (planId === "bad") throw new ToolError("not_eligible", "That plan isn't available on this account.");
      return { quoteId: "q_1", monthlyPrice: 29 };
    },
  });

  it("applies facts and commitments when run resolves", async () => {
    const { session } = await runTool(quote, { planId: "plus" }, verified());
    expect(session.facts.lastQuote).toBe("q_1");
    expect(session.commitments).toEqual([
      { type: "quote", id: "q_1", values: { monthlyPrice: 29 }, by: "quote_plan_change", turn: 0, status: "open" },
    ]);
  });

  it("records nothing when run throws", async () => {
    const before = verified();
    const { session } = await runTool(quote, { planId: "bad" }, before);
    expect(session.facts).toEqual(before.facts);
    expect(session.commitments).toEqual([]);
    expect(session.results).toHaveLength(1);           // the failed call is still in the results
  });
});

describe("errors", () => {
  it("passes ToolError through as a structured error", async () => {
    const tool = write({ name: "refund_invoice", description: "Refund.", input: z.object({ invoiceId: z.string() }),
      run: () => { throw new ToolError("outside_refund_window", "This invoice is past the 30-day refund window."); } });
    const { result } = await runTool(tool, { invoiceId: "inv_1" }, verified());
    expect(result).toMatchObject({ ok: false, error: { code: "outside_refund_window", message: "This invoice is past the 30-day refund window." } });
  });

  it("turns any other error into internal_error without leaking its message", async () => {
    const tool = read({ name: "get_x", description: "X.", input: z.object({}), run: () => { throw new Error("db password wrong"); } });
    const { result } = await runTool(tool, {}, verified());
    expect(result.error).toEqual({ code: "internal_error", message: "The tool failed unexpectedly." });
  });

  it("rejects invalid input before run() is called", async () => {
    const run = vi.fn();
    const tool = read({ name: "get_y", description: "Y.", input: z.object({ n: z.number() }), run });
    const { result } = await runTool(tool, { n: "seven" }, verified());
    expect(result.error?.code).toBe("invalid_input");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("definition checks", () => {
  it("requires an explicit snake_case name", () => {
    expect(() => read({ name: "getOrder", description: "x", input: z.object({}), run: () => 1 })).toThrow(/snake_case/);
  });
  it("only allows confirm on writes", () => {
    expect(() => read({ name: "get_z", description: "x", input: z.object({}), confirm: { commitment: "quote", by: "quoteId" }, run: () => 1 }))
      .toThrow(/write tools only/);
  });
});

describe("write outcomes on tool results", () => {
  it("records done by default, pending from outcome(), and unknown from ToolError({ outcome })", async () => {
    const mk = (run: () => unknown, outcome?: (o: any) => "done" | "pending") =>
      write({ name: "change_plan", description: "x", input: z.object({}), confirm: false, outcome, reconcileWith: "get_account", run });
    expect((await runTool(mk(() => ({ status: "active" })), {}, createSession())).result.outcome).toBe("done");
    expect((await runTool(mk(() => ({ status: "pending" }), (o) => (o.status === "pending" ? "pending" : "done")), {}, createSession())).result.outcome).toBe("pending");
    const t = await runTool(mk(() => { throw new ToolError("timeout", "No response.", { outcome: "unknown" }); }), {}, createSession());
    expect(t.result).toMatchObject({ ok: false, outcome: "unknown", error: { code: "timeout" } });
    expect(t.session.results[0].outcome).toBe("unknown");
    const f = await runTool(mk(() => { throw new ToolError("declined", "No."); }), {}, createSession());
    expect(f.result.outcome).toBeUndefined();                            // a known failure
  });
});
