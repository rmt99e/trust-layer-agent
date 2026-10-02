// Try the agent in your terminal: node --env-file=.env examples/subscriptions/chat.js
import { makeAgent } from "./agent.js";

await makeAgent().chat();
