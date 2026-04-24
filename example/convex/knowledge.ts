import { openai } from "@ai-sdk/openai";
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { AgentKnowledge } from "@convex-dev/agent-knowledge";

const neo4j =
  process.env.NEO4J_URI &&
  process.env.NEO4J_USER &&
  process.env.NEO4J_PASSWORD
    ? {
        uri: process.env.NEO4J_URI,
        user: process.env.NEO4J_USER,
        password: process.env.NEO4J_PASSWORD,
        ...(process.env.NEO4J_DATABASE === undefined
          ? {}
          : { database: process.env.NEO4J_DATABASE }),
      }
    : undefined;

const knowledge = new AgentKnowledge(components.agentKnowledge, {
  textEmbeddingModel: openai.embedding("text-embedding-3-small"),
  embeddingDimension: 1536,
  extractionModel: openai.chat("gpt-4o-mini"),
  ...(neo4j === undefined ? {} : { neo4j }),
});

export const remember = action({
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

export const recall = action({
  args: {
    namespace: v.string(),
    query: v.string(),
  },
  handler: async (ctx, args) => {
    return await knowledge.recall(ctx, {
      namespace: args.namespace,
      query: args.query,
      searchType: "hybrid",
      limit: 8,
    });
  },
});

export const observe = mutation({
  args: {
    namespace: v.string(),
    memoryId: v.string(),
    query: v.string(),
    outcome: v.union(
      v.literal("helpful"),
      v.literal("not_helpful"),
      v.literal("neutral"),
    ),
  },
  handler: async (ctx, args) => {
    await knowledge.observe(ctx, args);
  },
});

export const promote = mutation({
  args: {
    namespace: v.string(),
  },
  handler: async (ctx, args) => {
    return await knowledge.promote(ctx, args);
  },
});

export const listMemories = query({
  args: {
    namespace: v.string(),
  },
  handler: async (ctx, args) => {
    return await knowledge.listMemories(ctx, {
      namespace: args.namespace,
      limit: 25,
    });
  },
});
