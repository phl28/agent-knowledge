"use node";

import neo4j from "neo4j-driver";
import { v } from "convex/values";
import { action } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { memoryCardValidator, vectorTableForDimension } from "./validators.js";
import { fuseMemoryScores } from "../shared/ranking.js";

const neo4jConfigValidator = v.object({
  uri: v.string(),
  user: v.string(),
  password: v.string(),
  database: v.optional(v.string()),
});

type Neo4jConfig = {
  uri: string;
  user: string;
  password: string;
  database?: string;
};

type GraphMemoryScore = {
  memoryId: string;
  graphScore: number;
};

async function withNeo4j<T>(
  config: Neo4jConfig,
  fn: (session: neo4j.Session) => Promise<T>,
) {
  const driver = neo4j.driver(
    config.uri,
    neo4j.auth.basic(config.user, config.password),
  );
  const session = driver.session(
    config.database ? { database: config.database } : undefined,
  );
  try {
    return await fn(session);
  } finally {
    await session.close();
    await driver.close();
  }
}

async function upsertMemoryGraph(session: neo4j.Session, payload: any) {
  await session.executeWrite((tx) =>
    tx.run(
      `
      MERGE (m:Memory {id: $memory.id})
      SET m.namespace = $memory.namespace,
          m.key = $memory.key,
          m.agentId = $memory.agentId,
          m.text = $memory.text,
          m.importance = $memory.importance,
          m.updatedAt = timestamp()
      WITH m
      UNWIND $entities AS entity
      MERGE (e:Entity {id: entity.externalId})
      SET e.namespace = $memory.namespace,
          e.name = entity.name,
          e.type = entity.type,
          e.description = entity.description,
          e.confidence = coalesce(entity.confidence, 0.75),
          e.updatedAt = timestamp()
      MERGE (m)-[mention:MENTIONS]->(e)
      SET mention.namespace = $memory.namespace,
          mention.updatedAt = timestamp()
      `,
      {
        memory: payload.memory,
        entities: payload.entities ?? [],
      },
    ),
  );

  await session.executeWrite((tx) =>
    tx.run(
      `
      UNWIND $relationships AS relationship
      MATCH (from:Entity {id: relationship.fromEntityExternalId})
      MATCH (to:Entity {id: relationship.toEntityExternalId})
      MERGE (from)-[r:RELATED {namespace: $namespace, type: relationship.type}]->(to)
      SET r.description = relationship.description,
          r.confidence = coalesce(relationship.confidence, 0.75),
          r.weight = coalesce(relationship.weight, 0.5),
          r.memoryId = $memoryId,
          r.updatedAt = timestamp()
      `,
      {
        namespace: payload.memory.namespace,
        memoryId: payload.memory.id,
        relationships: payload.relationships ?? [],
      },
    ),
  );
}

async function deleteMemoryGraph(session: neo4j.Session, payload: any) {
  await session.executeWrite((tx) =>
    tx.run(
      `
      MATCH (m:Memory {id: $memoryId, namespace: $namespace})
      DETACH DELETE m
      `,
      {
        memoryId: payload.memoryId,
        namespace: payload.namespace,
      },
    ),
  );
}

async function promoteMemoryGraph(session: neo4j.Session, payload: any) {
  await session.executeWrite((tx) =>
    tx.run(
      `
      MATCH (m:Memory {id: $memoryId, namespace: $namespace})
      SET m.importance = $importance,
          m.observationScore = $observationScore,
          m.updatedAt = timestamp()
      `,
      {
        memoryId: payload.memoryId,
        namespace: payload.namespace,
        importance: payload.importance,
        observationScore: payload.observationScore,
      },
    ),
  );
}

async function expandGraph(
  config: Neo4jConfig,
  namespace: string,
  memoryIds: string[],
  entityHints: string[],
  hops: number,
) {
  if (memoryIds.length === 0 && entityHints.length === 0) {
    return [];
  }
  const safeHops = Math.min(Math.max(Math.trunc(hops), 1), 4);
  return await withNeo4j(config, async (session) => {
    const result =
      memoryIds.length > 0
        ? await session.executeRead((tx) =>
            tx.run(
              `
        MATCH (seed:Memory {namespace: $namespace})
        WHERE seed.id IN $memoryIds
        MATCH path = (seed)-[:MENTIONS]->(:Entity)-[:RELATED*1..${safeHops}]-(:Entity)<-[:MENTIONS]-(related:Memory {namespace: $namespace})
        WHERE NOT related.id IN $memoryIds
        RETURN related.id AS memoryId, count(path) AS graphScore
        ORDER BY graphScore DESC
        LIMIT 64
        `,
              { namespace, memoryIds },
            ),
          )
        : await session.executeRead((tx) =>
            tx.run(
              `
        MATCH (seed:Entity {namespace: $namespace})
        WHERE toLower(seed.name) IN $entityHints
        MATCH path = (seed)-[:RELATED*0..${safeHops}]-(:Entity)<-[:MENTIONS]-(related:Memory {namespace: $namespace})
        RETURN related.id AS memoryId, count(path) AS graphScore
        ORDER BY graphScore DESC
        LIMIT 64
        `,
              {
                namespace,
                entityHints: entityHints.map((hint) => hint.toLowerCase()),
              },
            ),
          );
    return result.records.map((record) => ({
      memoryId: record.get("memoryId") as string,
      graphScore: Number(record.get("graphScore")),
    })) satisfies GraphMemoryScore[];
  });
}

export const recall = action({
  args: {
    namespace: v.string(),
    query: v.string(),
    queryEmbedding: v.optional(v.array(v.float64())),
    embeddingDimension: v.number(),
    searchType: v.optional(
      v.union(v.literal("semantic"), v.literal("graph"), v.literal("hybrid")),
    ),
    limit: v.optional(v.number()),
    agentId: v.optional(v.string()),
    entityHints: v.optional(v.array(v.string())),
    neo4j: v.optional(neo4jConfigValidator),
  },
  returns: v.object({
    results: v.array(memoryCardValidator),
  }),
  handler: async (ctx, args) => {
    const searchType = args.searchType ?? "hybrid";
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 64);
    const semanticCards =
      searchType === "graph" || !args.queryEmbedding
        ? []
        : await (async () => {
            const vectorTable = vectorTableForDimension(args.embeddingDimension);
            const vectorResults = await ctx.vectorSearch(
              vectorTable,
              "by_embedding",
              {
                vector: args.queryEmbedding!,
                limit: Math.min(limit * 4, 256),
                filter: (q) =>
                  args.agentId
                    ? q.and(
                        q.eq("namespace", args.namespace),
                        q.eq("agentId", args.agentId),
                        q.eq("kind", "chunk"),
                      )
                    : q.and(
                        q.eq("namespace", args.namespace),
                        q.eq("kind", "chunk"),
                      ),
              },
            );
            return await ctx.runQuery(
              internal.queries.fetchMemoryCardsByVectorMatches,
              {
                embeddingDimension: args.embeddingDimension,
                matches: vectorResults.map((result) => ({
                  vectorId: result._id,
                  score: result._score,
                })),
              },
            );
          })();

    const seedMemoryIds = semanticCards.map((card) => card.memoryId);
    const graphScores =
      args.neo4j && searchType !== "semantic"
        ? await expandGraph(
            args.neo4j,
            args.namespace,
            seedMemoryIds,
            args.entityHints ?? [],
            2,
          )
        : [];
    const graphCards =
      graphScores.length === 0
        ? []
        : await ctx.runQuery(internal.queries.fetchMemoryCards, {
            matches: graphScores.map((result) => ({
              memoryId: result.memoryId,
              score: result.graphScore,
              graphScore: result.graphScore,
            })),
          });

    return {
      results: fuseMemoryScores(semanticCards, graphCards, { limit }),
    };
  },
});

export const syncGraph = action({
  args: {
    neo4j: neo4jConfigValidator,
    limit: v.optional(v.number()),
  },
  returns: v.object({
    succeeded: v.number(),
    failed: v.number(),
  }),
  handler: async (ctx, args) => {
    const jobs = await ctx.runQuery(internal.queries.listPendingGraphSyncJobs, {
      limit: Math.min(Math.max(args.limit ?? 10, 1), 100),
    });
    let succeeded = 0;
    let failed = 0;
    for (const job of jobs) {
      await ctx.runMutation(internal.mutations.markGraphSyncJobRunning, {
        jobId: job.jobId,
      });
      try {
        await withNeo4j(args.neo4j, async (session) => {
          if (job.operation === "upsert_memory") {
            await upsertMemoryGraph(session, job.payload);
          } else if (job.operation === "delete_memory") {
            await deleteMemoryGraph(session, job.payload);
          } else if (job.operation === "promote_memory") {
            await promoteMemoryGraph(session, job.payload);
          }
        });
        await ctx.runMutation(internal.mutations.markGraphSyncJobSucceeded, {
          jobId: job.jobId,
        });
        succeeded += 1;
      } catch (error) {
        await ctx.runMutation(internal.mutations.markGraphSyncJobFailed, {
          jobId: job.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
        failed += 1;
      }
    }
    return { succeeded, failed };
  },
});
