import { defineApp } from "convex/server";
import { v } from "convex/values";
import agentKnowledge from "convex-agent-knowledge/convex.config";

// Declare the Neo4j connection as app environment variables (set them in your
// deployment with `npx convex env set NEO4J_URI ...`) and pass them into the
// component by reference. The component reads them internally — application
// code never wires the connection into a graph store anymore.
const app = defineApp({
  env: {
    NEO4J_URI: v.string(),
    NEO4J_USER: v.string(),
    NEO4J_PASSWORD: v.string(),
    NEO4J_DATABASE: v.optional(v.string()),
  },
});

app.use(agentKnowledge, {
  env: {
    NEO4J_URI: app.env.NEO4J_URI,
    NEO4J_USER: app.env.NEO4J_USER,
    NEO4J_PASSWORD: app.env.NEO4J_PASSWORD,
    NEO4J_DATABASE: app.env.NEO4J_DATABASE,
  },
});

export default app;
