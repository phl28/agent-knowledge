import { defineApp } from "convex/server";
import agentKnowledge from "@convex-dev/agent-knowledge/convex.config.js";

const app = defineApp();
app.use(agentKnowledge);

export default app;
