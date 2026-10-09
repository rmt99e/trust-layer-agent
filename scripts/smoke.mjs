// Real-model smoke test: a tiny agent, one read tool, two turns, per available provider.
// Run with `npm run smoke` (loads .env via node --env-file). Never prints a key.
import { Agent, anthropic, createSession, openaiCompatible, read, teachingView, z } from "../dist/index.js";

const getPlan = read({
  name: "get_plan", description: "The user's current plan, price and renewal date.", input: z.object({}),
  visible: ["plan", "monthlyPrice", "renewsOn"],
  run: () => ({ plan: "Basic", monthlyPrice: 9, renewsOn: "2026-11-01" }),
});
const show = { write: teachingView };

async function ollamaModel() {
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(1000) });
    const { models } = await res.json();
    return process.env.SMOKE_OLLAMA_MODEL ?? models?.[0]?.name;
  } catch { return undefined; }
}

const providers = [
  { name: "anthropic", ready: !!process.env.ANTHROPIC_API_KEY, make: () => anthropic({ model: process.env.SMOKE_ANTHROPIC_MODEL ?? "claude-sonnet-5-5" }),
    cost: "≈ $0.015 (3–4 calls × ~1.5k input + ~300 output tokens at $2/$10 per M)" },
  { name: "openai", ready: !!process.env.OPENAI_API_KEY, make: () => openaiCompatible({ model: process.env.SMOKE_OPENAI_MODEL ?? "gpt-4.1", baseUrl: "https://api.openai.com/v1" }),
    cost: "≈ $0.01–0.03 depending on model" },
  { name: "ollama", ready: false, make: null, cost: "free (local)" },
];
const local = await ollamaModel();
if (local) Object.assign(providers[2], { ready: true, make: () => openaiCompatible({ model: local, baseUrl: "http://localhost:11434/v1", apiKey: "" }) });

for (const p of providers) {
  if (!p.ready) { console.log(`${p.name}: skipped (${p.name === "ollama" ? "no server at localhost:11434" : "no key"})`); continue; }
  const model = p.make();
  console.log(`\n${p.name}: ${model.id}, estimated cost ${p.cost}`);
  const agent = new Agent({ model, instructions: "You help customers with their subscription. Be brief.", tools: [getPlan], trace: show });
  let session = createSession({ facts: { verified: true } });
  for (const message of ["What plan am I on, and what does it cost?", "When does it renew?"]) {
    console.log(`  user: ${message}`);
    try {
      const r = await agent.respond(session, message);
      session = r.session;
      console.log(`  agent:    ${r.reply}${r.handoff ? `  [handoff: ${r.handoff.summary}]` : ""}`);
    } catch (e) { console.log(`  error:    ${e.message}`); break; }
  }
}
