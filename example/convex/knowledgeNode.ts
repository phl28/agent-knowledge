"use node";

import { openai } from "@ai-sdk/openai";
import { v } from "convex/values";
import { action } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { AgentKnowledge } from "convex-agent-knowledge";
import { createNeo4jGraphStore } from "convex-agent-knowledge/node";

const graph = createNeo4jGraphStore({
  uri: process.env.NEO4J_URI!,
  user: process.env.NEO4J_USER!,
  password: process.env.NEO4J_PASSWORD!,
  ...(process.env.NEO4J_DATABASE === undefined
    ? {}
    : { database: process.env.NEO4J_DATABASE }),
});

const knowledge = new AgentKnowledge(components.agentKnowledge, {
  textEmbeddingModel: openai.embedding("text-embedding-3-small"),
  embeddingDimension: 1536,
  extractionModel: openai.chat("gpt-4o-mini"),
  graph,
});

export const rememberAndSync = action({
  args: {
    namespace: v.string(),
    text: v.string(),
    key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await knowledge.remember(ctx, {
      namespace: args.namespace,
      key: args.key,
      text: args.text,
      source: { type: "example" },
    });
  },
});

export const recallHybrid = action({
  args: {
    namespace: v.string(),
    query: v.string(),
    entityHints: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    return await knowledge.recall(ctx, {
      namespace: args.namespace,
      query: args.query,
      searchType: "hybrid",
      limit: 8,
      ...(args.entityHints === undefined ? {} : { entityHints: args.entityHints }),
    });
  },
});

export const syncGraph = action({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await knowledge.syncGraph(ctx, {
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });
  },
});
