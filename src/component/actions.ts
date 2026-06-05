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
    // Convex vector-search filters support only `eq` and `or` (no `and`), so we
    // partition on a single field here — the namespace — and over-fetch, then
    // apply the remaining conditions (kind, agentId) as a post-filter when
    // resolving the cards below.
    const vectorResults = await ctx.vectorSearch(vectorTable, "by_embedding", {
      vector: args.queryEmbedding,
      limit: Math.min(limit * 4, 256),
      filter: (q) => q.eq("namespace", args.namespace),
    });
    const semanticCards = await ctx.runQuery("queries:fetchMemoryCardsByVectorMatches", {
      embeddingDimension: args.embeddingDimension,
      kind: "chunk",
      ...(args.agentId ? { agentId: args.agentId } : {}),
      matches: vectorResults.map((result) => ({
        vectorId: result._id,
        score: result._score,
      })),
    });
    return { results: semanticCards.slice(0, limit) };
  },
});
