import { defineApp } from "convex/server";
import agentKnowledge from "convex-agent-knowledge/convex.config";

const app = defineApp();
app.use(agentKnowledge);

export default app;
