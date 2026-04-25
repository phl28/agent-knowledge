// @ts-nocheck
import { v } from "convex/values";
import { mutation } from "./_generated/server.js";
import {
  chunkInputValidator,
  entityInputValidator,
  relationshipInputValidator,
  sourceValidator,
  vectorTableForDimension,
} from "./validators.js";
import { clamp } from "../shared/ranking.js";

type MutationCtx = any;

async function ensureNamespace(ctx: MutationCtx, namespace: string, metadata?: unknown) {
  const now = Date.now();
  const existing = await ctx.db
    .query("namespaces")
    .withIndex("by_namespace", (q) => q.eq("namespace", namespace))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, {
      updatedAt: now,
      ...(metadata === undefined ? {} : { metadata }),
    });
    return existing._id;
  }
  return await ctx.db.insert("namespaces", {
    namespace,
    ...(metadata === undefined ? {} : { metadata }),
    createdAt: now,
    updatedAt: now,
  });
}

async function deleteDerivedRows(
  ctx: MutationCtx,
  memory: { _id: string; embeddingDimension: number },
) {
  const [chunks, entities, relationships] = await Promise.all([
    ctx.db
      .query("chunks")
      .withIndex("by_memory", (q) => q.eq("memoryId", memory._id))
      .collect(),
    ctx.db
      .query("entities")
      .withIndex("by_memory", (q) => q.eq("memoryId", memory._id))
      .collect(),
    ctx.db
      .query("relationships")
      .withIndex("by_memory", (q) => q.eq("memoryId", memory._id))
      .collect(),
  ]);

  for (const relationship of relationships) {
    await ctx.db.delete(relationship._id);
  }
  for (const entity of entities) {
    await ctx.db.delete(entity._id);
  }
  for (const chunk of chunks) {
    await ctx.db.delete(chunk._id);
  }

  const vectorTable = vectorTableForDimension(memory.embeddingDimension);
  const vectorRows = await ctx.db
    .query(vectorTable)
    .withIndex("by_memory", (q) => q.eq("memoryId", memory._id))
    .collect();
  for (const vectorRow of vectorRows) {
    await ctx.db.delete(vectorRow._id);
  }
}

export const remember = mutation({
  args: {
    namespace: v.string(),
    key: v.optional(v.string()),
    agentId: v.optional(v.string()),
    text: v.string(),
    contentHash: v.string(),
    source: v.optional(sourceValidator),
    metadata: v.optional(v.any()),
    importance: v.optional(v.number()),
    embeddingDimension: v.number(),
    chunks: v.array(chunkInputValidator),
    entities: v.array(entityInputValidator),
    relationships: v.array(relationshipInputValidator),
  },
  returns: v.object({
    memoryId: v.string(),
    replacedMemoryId: v.optional(v.string()),
    chunkCount: v.number(),
    entityCount: v.number(),
    relationshipCount: v.number(),
    graphSyncJobId: v.string(),
  }),
  handler: async (ctx, args) => {
    if (args.chunks.length === 0) {
      throw new Error("remember requires at least one chunk");
    }
    const vectorTable = vectorTableForDimension(args.embeddingDimension);
    for (const chunk of args.chunks) {
      if (chunk.embedding.length !== args.embeddingDimension) {
        throw new Error(
          `Chunk embedding has dimension ${chunk.embedding.length}, expected ${args.embeddingDimension}`,
        );
      }
    }

    await ensureNamespace(ctx, args.namespace);
    const now = Date.now();
    let replacedMemoryId: string | undefined;

    const existing = args.key
      ? await ctx.db
          .query("memories")
          .withIndex("by_namespace_key", (q) =>
            q.eq("namespace", args.namespace).eq("key", args.key),
          )
          .filter((q) => q.eq(q.field("status"), "active"))
          .first()
      : await ctx.db
          .query("memories")
          .withIndex("by_namespace_hash", (q) =>
            q.eq("namespace", args.namespace).eq("contentHash", args.contentHash),
          )
          .filter((q) => q.eq(q.field("status"), "active"))
          .first();

    if (existing) {
      replacedMemoryId = existing._id;
      await deleteDerivedRows(ctx, existing);
      await ctx.db.patch(existing._id, {
        status: "deleted",
        deletedAt: now,
        updatedAt: now,
      });
    }

    const memoryId = await ctx.db.insert("memories", {
      namespace: args.namespace,
      ...(args.key === undefined ? {} : { key: args.key }),
      ...(args.agentId === undefined ? {} : { agentId: args.agentId }),
      text: args.text,
      contentHash: args.contentHash,
      ...(args.source === undefined ? {} : { source: args.source }),
      ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
      status: "active",
      importance: clamp(args.importance ?? 0.5),
      observationScore: 0,
      embeddingDimension: args.embeddingDimension,
      chunkCount: args.chunks.length,
      entityCount: args.entities.length,
      relationshipCount: args.relationships.length,
      createdAt: now,
      updatedAt: now,
    });

    const chunkIds = [];
    for (let order = 0; order < args.chunks.length; order += 1) {
      const chunk = args.chunks[order]!;
      const chunkId = await ctx.db.insert("chunks", {
        namespace: args.namespace,
        memoryId,
        ...(args.agentId === undefined ? {} : { agentId: args.agentId }),
        order,
        text: chunk.text,
        ...(chunk.summary === undefined ? {} : { summary: chunk.summary }),
        ...(chunk.tokenCount === undefined ? {} : { tokenCount: chunk.tokenCount }),
        ...(chunk.metadata === undefined ? {} : { metadata: chunk.metadata }),
        createdAt: now,
      });
      chunkIds.push(chunkId);
      await ctx.db.insert(vectorTable, {
        namespace: args.namespace,
        memoryId,
        chunkId,
        agentId: args.agentId ?? "",
        kind: "chunk",
        embedding: chunk.embedding,
      });
    }

    for (const entity of args.entities) {
      await ctx.db.insert("entities", {
        namespace: args.namespace,
        memoryId,
        externalId: entity.externalId,
        name: entity.name,
        type: entity.type,
        ...(entity.description === undefined ? {} : { description: entity.description }),
        ...(entity.aliases === undefined ? {} : { aliases: entity.aliases }),
        confidence: entity.confidence ?? 0.75,
        ...(entity.metadata === undefined ? {} : { metadata: entity.metadata }),
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const relationship of args.relationships) {
      await ctx.db.insert("relationships", {
        namespace: args.namespace,
        memoryId,
        fromEntityExternalId: relationship.fromEntityExternalId,
        toEntityExternalId: relationship.toEntityExternalId,
        type: relationship.type,
        ...(relationship.description === undefined
          ? {}
          : { description: relationship.description }),
        confidence: relationship.confidence ?? 0.75,
        weight: relationship.weight ?? 0.5,
        ...(relationship.metadata === undefined ? {} : { metadata: relationship.metadata }),
        createdAt: now,
        updatedAt: now,
      });
    }

    const graphSyncJobId = await ctx.db.insert("graphSyncJobs", {
      namespace: args.namespace,
      memoryId,
      operation: "upsert_memory",
      status: "pending",
      attempts: 0,
      payload: {
        memory: {
          id: memoryId,
          namespace: args.namespace,
          key: args.key,
          agentId: args.agentId,
          text: args.text,
          source: args.source,
          metadata: args.metadata,
          importance: args.importance ?? 0.5,
        },
        entities: args.entities,
        relationships: args.relationships,
      },
      createdAt: now,
      updatedAt: now,
    });

    return {
      memoryId,
      ...(replacedMemoryId === undefined ? {} : { replacedMemoryId }),
      chunkCount: args.chunks.length,
      entityCount: args.entities.length,
      relationshipCount: args.relationships.length,
      graphSyncJobId,
    };
  },
});

export const observe = mutation({
  args: {
    namespace: v.string(),
    memoryId: v.string(),
    query: v.string(),
    outcome: v.union(v.literal("helpful"), v.literal("not_helpful"), v.literal("neutral")),
    feedback: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const memoryId = ctx.db.normalizeId("memories", args.memoryId);
    if (!memoryId) {
      throw new Error(`Invalid memoryId ${args.memoryId}`);
    }
    const memory = await ctx.db.get(memoryId);
    if (!memory || memory.namespace !== args.namespace || memory.status !== "active") {
      throw new Error(`Memory ${args.memoryId} not found in ${args.namespace}`);
    }
    const now = Date.now();
    await ctx.db.insert("observations", {
      namespace: args.namespace,
      memoryId,
      query: args.query,
      outcome: args.outcome,
      ...(args.feedback === undefined ? {} : { feedback: args.feedback }),
      ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
      createdAt: now,
    });
  },
});

export const promote = mutation({
  args: {
    namespace: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    promoted: v.number(),
  }),
  handler: async (ctx, args) => {
    const observations = await ctx.db
      .query("observations")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .order("desc")
      .take(args.limit ?? 250);
    const scores = new Map<string, number>();
    for (const observation of observations) {
      const delta =
        observation.outcome === "helpful" ? 1 : observation.outcome === "not_helpful" ? -1 : 0;
      scores.set(observation.memoryId, (scores.get(observation.memoryId) ?? 0) + delta);
    }

    const now = Date.now();
    let promoted = 0;
    for (const [memoryIdString, observationScore] of scores) {
      const memoryId = ctx.db.normalizeId("memories", memoryIdString);
      if (!memoryId) {
        continue;
      }
      const memory = await ctx.db.get(memoryId);
      if (!memory || memory.status !== "active") {
        continue;
      }
      const importance = clamp(memory.importance + observationScore * 0.03);
      await ctx.db.patch(memoryId, {
        observationScore,
        importance,
        updatedAt: now,
      });
      await ctx.db.insert("graphSyncJobs", {
        namespace: args.namespace,
        memoryId,
        operation: "promote_memory",
        status: "pending",
        attempts: 0,
        payload: {
          memoryId,
          namespace: args.namespace,
          observationScore,
          importance,
        },
        createdAt: now,
        updatedAt: now,
      });
      promoted += 1;
    }
    return { promoted };
  },
});

export const deleteByKey = mutation({
  args: {
    namespace: v.string(),
    key: v.string(),
  },
  returns: v.object({
    deleted: v.boolean(),
    memoryId: v.optional(v.string()),
    graphSyncJobId: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const memory = await ctx.db
      .query("memories")
      .withIndex("by_namespace_key", (q) => q.eq("namespace", args.namespace).eq("key", args.key))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();
    if (!memory) {
      return { deleted: false };
    }
    const now = Date.now();
    await deleteDerivedRows(ctx, memory);
    await ctx.db.patch(memory._id, {
      status: "deleted",
      deletedAt: now,
      updatedAt: now,
    });
    const graphSyncJobId = await ctx.db.insert("graphSyncJobs", {
      namespace: args.namespace,
      memoryId: memory._id,
      operation: "delete_memory",
      status: "pending",
      attempts: 0,
      payload: {
        memoryId: memory._id,
        namespace: args.namespace,
      },
      createdAt: now,
      updatedAt: now,
    });
    return { deleted: true, memoryId: memory._id, graphSyncJobId };
  },
});

export const markGraphSyncJobRunning = mutation({
  args: {
    jobId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const jobId = ctx.db.normalizeId("graphSyncJobs", args.jobId);
    if (!jobId) {
      return null;
    }
    const job = await ctx.db.get(jobId);
    if (!job) {
      return null;
    }
    await ctx.db.patch(jobId, {
      status: "running",
      attempts: job.attempts + 1,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const markGraphSyncJobSucceeded = mutation({
  args: {
    jobId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const jobId = ctx.db.normalizeId("graphSyncJobs", args.jobId);
    if (jobId) {
      await ctx.db.patch(jobId, {
        status: "succeeded",
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

export const markGraphSyncJobFailed = mutation({
  args: {
    jobId: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const jobId = ctx.db.normalizeId("graphSyncJobs", args.jobId);
    if (jobId) {
      await ctx.db.patch(jobId, {
        status: "failed",
        lastError: args.error,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});
