// @ts-nocheck
import { v } from "convex/values";
import { action } from "./_generated/server.js";
import { memoryCardValidator, vectorTableForDimension } from "./validators.js";

export const recall = action({
  args: {
    namespace: v.string(),
    query: v.string(),
    queryEmbedding: v.optional(v.array(v.float64())),
    embeddingDimension: v.number(),
    searchType: v.optional(v.union(v.literal("semantic"), v.literal("graph"), v.literal("hybrid"))),
    limit: v.optional(v.number()),
    agentId: v.optional(v.string()),
  },
  returns: v.object({
    results: v.array(memoryCardValidator),
  }),
  handler: async (ctx, args) => {
    const searchType = args.searchType ?? "hybrid";
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 64);
    if (searchType === "graph" || !args.queryEmbedding) {
      return { results: [] };
    }
    const vectorTable = vectorTableForDimension(args.embeddingDimension);
    const vectorResults = await ctx.vectorSearch(vectorTable, "by_embedding", {
      vector: args.queryEmbedding,
      limit: Math.min(limit * 4, 256),
      filter: (q) =>
        args.agentId
          ? q.and(
              q.eq("namespace", args.namespace),
              q.eq("agentId", args.agentId),
              q.eq("kind", "chunk"),
            )
          : q.and(q.eq("namespace", args.namespace), q.eq("kind", "chunk")),
    });
    const semanticCards = await ctx.runQuery("queries:fetchMemoryCardsByVectorMatches", {
      embeddingDimension: args.embeddingDimension,
      matches: vectorResults.map((result) => ({
        vectorId: result._id,
        score: result._score,
      })),
    });
    return { results: semanticCards.slice(0, limit) };
  },
});
