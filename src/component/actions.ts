// @ts-nocheck
import { v } from "convex/values";
import { action } from "./_generated/server.js";
import { memoryCardValidator, vectorTableForDimension } from "./validators.js";
import { fuseMemoryScores } from "../shared/ranking.js";
import { expand, neo4jHttpFromEnv } from "./neo4j.js";

export const recall = action({
  args: {
    namespace: v.string(),
    query: v.string(),
    queryEmbedding: v.optional(v.array(v.float64())),
    embeddingDimension: v.number(),
    searchType: v.optional(v.union(v.literal("semantic"), v.literal("graph"), v.literal("hybrid"))),
    limit: v.optional(v.number()),
    agentId: v.optional(v.string()),
    entityHints: v.optional(v.array(v.string())),
  },
  returns: v.object({
    results: v.array(memoryCardValidator),
  }),
  handler: async (ctx, args) => {
    const searchType = args.searchType ?? "hybrid";
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 64);
    const now = Date.now();

    let semanticCards = [];
    if (searchType !== "graph" && args.queryEmbedding) {
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
      semanticCards = await ctx.runQuery("queries:fetchMemoryCardsByVectorMatches", {
        embeddingDimension: args.embeddingDimension,
        kind: "chunk",
        ...(args.agentId ? { agentId: args.agentId } : {}),
        matches: vectorResults.map((result) => ({
          vectorId: result._id,
          score: result._score,
        })),
      });
    }

    if (searchType === "semantic") {
      // Fuse with an empty graph set so the semantic-only path (also what the
      // app retries with when the graph is down) scores identically to hybrid:
      // decayed relevance plus the undecayed importance term.
      return { results: fuseMemoryScores(semanticCards, [], { limit, now }) };
    }

    // graph + hybrid: expand the graph from the semantic seeds (or from entity
    // hints when there is no semantic query) and fuse the two score signals.
    // Called inline rather than via a separate action to avoid an extra
    // function hop (recall already runs in the component with the same env).
    const seedMemoryIds = semanticCards.map((card) => card.memoryId);
    const hasEntityHints = Array.isArray(args.entityHints) && args.entityHints.length > 0;
    const graphScores =
      seedMemoryIds.length > 0 || hasEntityHints
        ? await expand(neo4jHttpFromEnv(), {
            namespace: args.namespace,
            seedMemoryIds,
            hops: 2,
            limit: Math.max(limit * 4, 16),
            ...(args.entityHints ? { entityHints: args.entityHints } : {}),
          })
        : [];
    const graphCards =
      graphScores.length === 0
        ? []
        : await ctx.runQuery("queries:fetchMemoryCards", {
            matches: graphScores.map((score) => ({
              memoryId: score.memoryId,
              score: score.graphScore,
              graphScore: score.graphScore,
            })),
          });

    return { results: fuseMemoryScores(semanticCards, graphCards, { limit, now }) };
  },
});
