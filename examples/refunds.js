// The 10-line quickstart: node --env-file=.env examples/refunds.js
import { Agent, read, write, z } from "trust-layer-agent";

const orders = { "123": { id: "123", total: 42, status: "delivered" } };

const getOrder = read({ name: "get_order", description: "Look up an order.",
  input: z.object({ orderId: z.string() }), run: ({ orderId }) => orders[orderId] ?? { error: "not found" } });

const refund = write({ name: "refund_order", description: "Refund an order in full.",
  input: z.object({ orderId: z.string() }), run: ({ orderId }) => ({ refunded: orders[orderId].total }) });

const agent = new Agent({ model: "anthropic:claude-sonnet-5-5", instructions: "You help customers with their orders. Reply in plain text.", tools: [getOrder, refund] });
await agent.chat();   // try it in the terminal
