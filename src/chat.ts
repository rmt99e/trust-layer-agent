import { createInterface } from "node:readline";
import type { Reply } from "./agent.js";
import type { Session } from "./session.js";

export type Observer = (line: Record<string, any>) => void;

// The teaching view: every tool call, blocked action and blocked draft is printed inline.
const show: Observer = (l) => {
  if (l.type === "tool") console.log(`   · ${l.tool} → ${l.ok ? "ok" : `failed (${l.error?.code})`}`);
  if (l.type === "check" && l.event === "action") console.log(`   ✗ blocked ${l.tool}  [${l.check}]  ${l.result.block}`);
  if (l.type === "check" && l.event === "reply" && "block" in l.result)
    console.log(`   ✗ draft not sent  [${l.check}]\n     draft:  ${JSON.stringify(l.draft)}\n     reason: ${l.result.block}`);
  if (l.type === "check" && l.event === "reply" && "rewrite" in l.result) console.log(`   ~ draft rewritten  [${l.check}]`);
};

export async function chatLoop(respond: (s: Session | null, m: string, o: Observer) => Promise<Reply>, opts: { session?: Session } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let session = opts.session ?? null;
  console.log("Chatting with your agent. Checks are shown inline. Type /quit to stop.\n");
  try {
    rl.setPrompt("you   > ");
    rl.prompt();
    for await (const line of rl) {                    // queues lines typed or pasted while the agent works
      const message = line.trim();
      if (message === "/quit") break;
      if (message) {
        const r = await respond(session, message, show);
        session = r.session;
        console.log(`agent > ${r.reply}\n`);
        if (r.handoff) { console.log(`[handed off: ${r.handoff.summary} (${r.handoff.reason})]`); break; }
      }
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}
