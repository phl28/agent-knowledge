import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const sourceValidator = v.object({
  type: v.string(),
  id: v.optional(v.string()),
  url: v.optional(v.string()),
  title: v.optional(v.string()),
});

const memoryStatus = v.union(v.literal("active"), v.literal("deleted"), v.literal("pending"));

const syncStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
);

const vectorRowFields = {
  namespace: v.string(),
  memoryId: v.id("memories"),
  chunkId: v.id("chunks"),
  agentId: v.string(),
  kind: v.string(),
  embedding: v.array(v.float64()),
};

function vectorTable(dimensions: number) {
  return defineTable(vectorRowFields)
    .index("by_memory", ["memoryId"])
    .index("by_chunk", ["chunkId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions,
      filterFields: ["namespace", "agentId", "kind"],
    });
}

export default defineSchema({
  namespaces: defineTable({
    namespace: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_namespace", ["namespace"]),

  memories: defineTable({
    namespace: v.string(),
    key: v.optional(v.string()),
    agentId: v.optional(v.string()),
    text: v.string(),
    contentHash: v.string(),
    source: v.optional(sourceValidator),
    metadata: v.optional(v.any()),
    status: memoryStatus,
    importance: v.number(),
    observationScore: v.number(),
    embeddingDimension: v.number(),
    chunkCount: v.number(),
    entityCount: v.number(),
    relationshipCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.optional(v.number()),
  })
    .index("by_namespace", ["namespace"])
    .index("by_namespace_key", ["namespace", "key"])
    .index("by_namespace_hash", ["namespace", "contentHash"])
    .index("by_agent", ["namespace", "agentId"]),

  chunks: defineTable({
    namespace: v.string(),
    memoryId: v.id("memories"),
    agentId: v.optional(v.string()),
    order: v.number(),
    text: v.string(),
    summary: v.optional(v.string()),
    tokenCount: v.optional(v.number()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_memory", ["memoryId", "order"])
    .index("by_namespace", ["namespace"]),

  entities: defineTable({
    namespace: v.string(),
    memoryId: v.id("memories"),
    chunkId: v.optional(v.id("chunks")),
    externalId: v.string(),
    name: v.string(),
    type: v.string(),
    description: v.optional(v.string()),
    aliases: v.optional(v.array(v.string())),
    confidence: v.number(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_memory", ["memoryId"])
    .index("by_namespace_name", ["namespace", "name"])
    .index("by_external_id", ["namespace", "externalId"]),

  relationships: defineTable({
    namespace: v.string(),
    memoryId: v.id("memories"),
    fromEntityExternalId: v.string(),
    toEntityExternalId: v.string(),
    type: v.string(),
    description: v.optional(v.string()),
    confidence: v.number(),
    weight: v.number(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_memory", ["memoryId"])
    .index("by_from", ["namespace", "fromEntityExternalId"])
    .index("by_to", ["namespace", "toEntityExternalId"]),

  observations: defineTable({
    namespace: v.string(),
    memoryId: v.id("memories"),
    query: v.string(),
    outcome: v.union(v.literal("helpful"), v.literal("not_helpful"), v.literal("neutral")),
    feedback: v.optional(v.string()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_memory", ["memoryId"])
    .index("by_namespace", ["namespace"]),

  graphSyncJobs: defineTable({
    namespace: v.string(),
    memoryId: v.optional(v.id("memories")),
    operation: v.union(
      v.literal("upsert_memory"),
      v.literal("delete_memory"),
      v.literal("promote_memory"),
      v.literal("forget_namespace"),
    ),
    status: syncStatus,
    attempts: v.number(),
    payload: v.any(),
    lastError: v.optional(v.string()),
    // Earliest time a retryable job may be re-claimed. Unset means "due now".
    nextAttemptAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_memory", ["memoryId"]),

  vectors_128: vectorTable(128),
  vectors_256: vectorTable(256),
  vectors_384: vectorTable(384),
  vectors_512: vectorTable(512),
  vectors_768: vectorTable(768),
  vectors_1024: vectorTable(1024),
  vectors_1536: vectorTable(1536),
  vectors_2048: vectorTable(2048),
  vectors_3072: vectorTable(3072),
  vectors_4096: vectorTable(4096),
});
