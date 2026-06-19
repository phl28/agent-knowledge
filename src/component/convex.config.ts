import { defineComponent } from "convex/server";
import { v } from "convex/values";

const component = defineComponent("agentKnowledge", {
  env: {
    NEO4J_URI: v.string(),
    NEO4J_USER: v.string(),
    NEO4J_PASSWORD: v.string(),
    NEO4J_DATABASE: v.optional(v.string()),
  },
});

export default component;
