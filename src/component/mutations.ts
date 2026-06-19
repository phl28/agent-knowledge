// @ts-nocheck
import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import {
  chunkInputValidator,
  entityInputValidator,
  relationshipInputValidator,
  sourceValidator,
  vectorTableForDimension,
} from "./validators.js";
import { clamp } from "../shared/ranking.js";

type MutationCtx = any;

const GRAPH_DRAIN_BATCH = 25;
// A graph sync job stuck in "running" past this window is treated as crashed
// (the drain died before completing it) and is reclaimable.
const STALE_RUNNING_MS = 5 * 60 * 1000;

// Kick the internal Neo4j drain. Enqueuing a job and triggering the drain are
// the only graph-related things a write does; everything else (running Neo4j,
// retries, backoff) happens inside the component's graph node action.
async function scheduleGraphDrain(ctx: MutationCtx) {
  await ctx.scheduler.runAfter(0, internal.graph.processPendingJobs, { limit: GRAPH_DRAIN_BATCH });
}

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

    await scheduleGraphDrain(ctx);

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
    if (promoted > 0) {
      await scheduleGraphDrain(ctx);
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
    await scheduleGraphDrain(ctx);
    return { deleted: true, memoryId: memory._id, graphSyncJobId };
  },
});

// Memories fan out into chunks/vectors/entities/relationships, so they are
// purged in smaller batches than the single-row observations.
const FORGET_MEMORY_BATCH = 50;
const FORGET_OBSERVATION_BATCH = 500;

// Purge an entire namespace (e.g. account deletion / GDPR). Deletion runs in
// bounded batches that reschedule themselves until the namespace is empty, so a
// large namespace never exceeds a single Convex transaction. Neo4j is cleared
// via a forget_namespace graph sync job enqueued once on the first pass and
// drained internally with the usual retry semantics.
export const forgetNamespace = mutation({
  args: { namespace: v.string(), graphJobEnqueued: v.optional(v.boolean()) },
  returns: v.object({ deletedMemories: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    if (!args.graphJobEnqueued) {
      await ctx.db.insert("graphSyncJobs", {
        namespace: args.namespace,
        operation: "forget_namespace",
        status: "pending",
        attempts: 0,
        payload: { namespace: args.namespace },
        createdAt: now,
        updatedAt: now,
      });
      await scheduleGraphDrain(ctx);
    }

    const memories = await ctx.db
      .query("memories")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .take(FORGET_MEMORY_BATCH);
    for (const memory of memories) {
      const jobs = await ctx.db
        .query("graphSyncJobs")
        .withIndex("by_memory", (q) => q.eq("memoryId", memory._id))
        .collect();
      for (const job of jobs) {
        await ctx.db.delete(job._id);
      }
      await deleteDerivedRows(ctx, memory);
      await ctx.db.delete(memory._id);
    }
    if (memories.length === FORGET_MEMORY_BATCH) {
      await ctx.scheduler.runAfter(0, internal.mutations.forgetNamespace, {
        namespace: args.namespace,
        graphJobEnqueued: true,
      });
      return { deletedMemories: memories.length, isDone: false };
    }

    const observations = await ctx.db
      .query("observations")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .take(FORGET_OBSERVATION_BATCH);
    for (const observation of observations) {
      await ctx.db.delete(observation._id);
    }
    if (observations.length === FORGET_OBSERVATION_BATCH) {
      await ctx.scheduler.runAfter(0, internal.mutations.forgetNamespace, {
        namespace: args.namespace,
        graphJobEnqueued: true,
      });
      return { deletedMemories: memories.length, isDone: false };
    }

    const namespaceDoc = await ctx.db
      .query("namespaces")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .unique();
    if (namespaceDoc) {
      await ctx.db.delete(namespaceDoc._id);
    }
    return { deletedMemories: memories.length, isDone: true };
  },
});

// Atomically claim due graph sync jobs for the drain: pending jobs whose
// backoff has elapsed, plus jobs stuck "running" past STALE_RUNNING_MS (a
// previous drain crashed mid-flight). Marking them "running" in the same
// transaction prevents the post-write drain, the self-reschedule, and the
// retry cron from processing the same job concurrently.
export const claimGraphSyncJobs = internalMutation({
  args: {
    limit: v.number(),
  },
  returns: v.array(
    v.object({
      jobId: v.string(),
      namespace: v.string(),
      operation: v.string(),
      attempts: v.number(),
      payload: v.any(),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const scan = Math.max(args.limit * 4, args.limit);
    const pending = await ctx.db
      .query("graphSyncJobs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("asc")
      .take(scan);
    const running = await ctx.db
      .query("graphSyncJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .order("asc")
      .take(scan);

    const candidates = [
      ...pending.filter((job) => (job.nextAttemptAt ?? 0) <= now),
      ...running.filter((job) => now - job.updatedAt >= STALE_RUNNING_MS),
    ].slice(0, args.limit);

    const claimed = [];
    for (const job of candidates) {
      const attempts = job.attempts + 1;
      await ctx.db.patch(job._id, { status: "running", attempts, updatedAt: now });
      claimed.push({
        jobId: job._id,
        namespace: job.namespace,
        operation: job.operation,
        attempts,
        payload: job.payload,
      });
    }
    return claimed;
  },
});

// Resolve a claimed job. No error => succeeded. error + retryAt => schedule a
// retry. error without retryAt => dead-letter (left "failed" with lastError).
export const completeGraphSyncJob = internalMutation({
  args: {
    jobId: v.string(),
    error: v.optional(v.string()),
    retryAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const jobId = ctx.db.normalizeId("graphSyncJobs", args.jobId);
    if (!jobId) {
      return null;
    }
    const now = Date.now();
    if (args.error === undefined) {
      await ctx.db.patch(jobId, { status: "succeeded", updatedAt: now });
    } else if (args.retryAt !== undefined) {
      await ctx.db.patch(jobId, {
        status: "pending",
        lastError: args.error,
        nextAttemptAt: args.retryAt,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(jobId, { status: "failed", lastError: args.error, updatedAt: now });
    }
    return null;
  },
});
