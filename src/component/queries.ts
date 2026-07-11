// @ts-nocheck
import { v } from "convex/values";
import { internalQuery, query } from "./_generated/server.js";
import { memoryCardValidator, vectorTableForDimension } from "./validators.js";

type QueryCtx = any;

async function getActiveMemory(ctx: QueryCtx, memoryId: string) {
  const id = ctx.db.normalizeId("memories", memoryId);
  if (!id) {
    return null;
  }
  const memory = await ctx.db.get(id);
  if (!memory || memory.status !== "active") {
    return null;
  }
  return memory;
}

async function buildMemoryCard(
  ctx: QueryCtx,
  memoryId: string,
  score: number,
  scores?: { semanticScore?: number; graphScore?: number },
) {
  const memory = await getActiveMemory(ctx, memoryId);
  if (!memory) {
    return null;
  }
  const [entities, relationships] = await Promise.all([
    ctx.db
      .query("entities")
      .withIndex("by_memory", (q) => q.eq("memoryId", memory._id))
      .collect(),
    ctx.db
      .query("relationships")
      .withIndex("by_memory", (q) => q.eq("memoryId", memory._id))
      .collect(),
  ]);

  return {
    memoryId: memory._id,
    namespace: memory.namespace,
    ...(memory.key === undefined ? {} : { key: memory.key }),
    ...(memory.agentId === undefined ? {} : { agentId: memory.agentId }),
    text: memory.text,
    score,
    ...(scores?.semanticScore === undefined ? {} : { semanticScore: scores.semanticScore }),
    ...(scores?.graphScore === undefined ? {} : { graphScore: scores.graphScore }),
    importance: memory.importance,
    createdAt: memory.createdAt,
    ...(memory.lastAccessedAt === undefined ? {} : { lastAccessedAt: memory.lastAccessedAt }),
    ...(memory.source === undefined ? {} : { source: memory.source }),
    ...(memory.metadata === undefined ? {} : { metadata: memory.metadata }),
    entities: entities.map((entity) => ({
      externalId: entity.externalId,
      name: entity.name,
      type: entity.type,
      ...(entity.description === undefined ? {} : { description: entity.description }),
      confidence: entity.confidence,
    })),
    relationships: relationships.map((relationship) => ({
      fromEntityExternalId: relationship.fromEntityExternalId,
      toEntityExternalId: relationship.toEntityExternalId,
      type: relationship.type,
      ...(relationship.description === undefined ? {} : { description: relationship.description }),
      confidence: relationship.confidence,
      weight: relationship.weight,
    })),
  };
}

export const getMemory = query({
  args: {
    memoryId: v.string(),
  },
  returns: v.nullable(memoryCardValidator),
  handler: async (ctx, args) => {
    return await buildMemoryCard(ctx, args.memoryId, 1);
  },
});

export const listMemories = query({
  args: {
    namespace: v.string(),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(memoryCardValidator),
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("memories")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .filter((q) => q.eq(q.field("status"), "active"))
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: args.limit ?? 25,
      });

    const cards = [];
    for (const memory of page.page) {
      const card = await buildMemoryCard(ctx, memory._id, memory.importance);
      if (card) {
        cards.push(card);
      }
    }
    return { ...page, page: cards };
  },
});

export const fetchMemoryCards = query({
  args: {
    matches: v.array(
      v.object({
        memoryId: v.string(),
        score: v.number(),
        semanticScore: v.optional(v.number()),
        graphScore: v.optional(v.number()),
      }),
    ),
  },
  returns: v.array(memoryCardValidator),
  handler: async (ctx, args) => {
    const cards = [];
    for (const match of args.matches) {
      const card = await buildMemoryCard(ctx, match.memoryId, match.score, {
        semanticScore: match.semanticScore,
        graphScore: match.graphScore,
      });
      if (card) {
        cards.push(card);
      }
    }
    return cards;
  },
});

export const fetchMemoryCardsByVectorMatches = internalQuery({
  args: {
    embeddingDimension: v.number(),
    // Conditions the vector search couldn't AND on the index — applied here as a
    // post-filter against each matched row.
    kind: v.optional(v.string()),
    agentId: v.optional(v.string()),
    matches: v.array(
      v.object({
        vectorId: v.string(),
        score: v.number(),
      }),
    ),
  },
  returns: v.array(memoryCardValidator),
  handler: async (ctx, args) => {
    const table = vectorTableForDimension(args.embeddingDimension);
    const cards = [];
    for (const match of args.matches) {
      const vectorId = ctx.db.normalizeId(table, match.vectorId);
      if (!vectorId) {
        continue;
      }
      const vectorRow = await ctx.db.get(vectorId);
      if (!vectorRow) {
        continue;
      }
      if (args.kind && vectorRow.kind !== args.kind) {
        continue;
      }
      if (args.agentId && vectorRow.agentId !== args.agentId) {
        continue;
      }
      const card = await buildMemoryCard(ctx, vectorRow.memoryId, match.score, {
        semanticScore: match.score,
      });
      if (card) {
        cards.push(card);
      }
    }
    return cards;
  },
});
