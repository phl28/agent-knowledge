import neo4j from "neo4j-driver";
import type {
  GraphExpandInput,
  GraphMemoryScore,
  GraphStore,
  GraphSyncJob,
  Neo4jConfig,
} from "../client/types.js";

export type Neo4jGraphStoreOptions = Neo4jConfig;

export function createNeo4jGraphStore(options: Neo4jGraphStoreOptions): GraphStore {
  return {
    async syncJob(job) {
      await withNeo4j(options, async (session) => {
        if (job.operation === "upsert_memory") {
          await upsertMemoryGraph(session, job.payload);
        } else if (job.operation === "delete_memory") {
          await deleteMemoryGraph(session, job.payload);
        } else if (job.operation === "promote_memory") {
          await promoteMemoryGraph(session, job.payload);
        } else if (job.operation === "forget_namespace") {
          await forgetNamespaceGraph(session, job.payload);
        } else {
          throw new Error(`Unsupported graph sync operation ${job.operation}`);
        }
      });
    },
    async expand(input) {
      return await expandGraph(options, input);
    },
  };
}

async function forgetNamespaceGraph(session: neo4j.Session, payload: unknown) {
  const { namespace } = payload as { namespace: string };
  await session.executeWrite((tx) =>
    tx.run("MATCH (n {namespace: $namespace}) DETACH DELETE n", { namespace }),
  );
}

async function withNeo4j<T>(config: Neo4jConfig, fn: (session: neo4j.Session) => Promise<T>) {
  const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
  const session = driver.session(config.database ? { database: config.database } : undefined);
  try {
    return await fn(session);
  } finally {
    await session.close();
    await driver.close();
  }
}

async function upsertMemoryGraph(session: neo4j.Session, payload: unknown) {
  const graphPayload = payload as {
    memory: Record<string, unknown> & {
      id: string;
      namespace: string;
      importance?: number;
    };
    entities?: Array<Record<string, unknown>>;
    relationships?: Array<Record<string, unknown>>;
  };
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
        memory: graphPayload.memory,
        entities: graphPayload.entities ?? [],
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
        namespace: graphPayload.memory.namespace,
        memoryId: graphPayload.memory.id,
        relationships: graphPayload.relationships ?? [],
      },
    ),
  );
}

async function deleteMemoryGraph(session: neo4j.Session, payload: unknown) {
  const graphPayload = payload as { memoryId: string; namespace: string };
  await session.executeWrite((tx) =>
    tx.run(
      `
      MATCH (m:Memory {id: $memoryId, namespace: $namespace})
      DETACH DELETE m
      `,
      graphPayload,
    ),
  );
}

async function promoteMemoryGraph(session: neo4j.Session, payload: unknown) {
  const graphPayload = payload as {
    memoryId: string;
    namespace: string;
    importance: number;
    observationScore: number;
  };
  await session.executeWrite((tx) =>
    tx.run(
      `
      MATCH (m:Memory {id: $memoryId, namespace: $namespace})
      SET m.importance = $importance,
          m.observationScore = $observationScore,
          m.updatedAt = timestamp()
      `,
      graphPayload,
    ),
  );
}

async function expandGraph(
  config: Neo4jConfig,
  input: GraphExpandInput,
): Promise<GraphMemoryScore[]> {
  const seedMemoryIds = input.seedMemoryIds;
  const entityHints = input.entityHints ?? [];
  if (seedMemoryIds.length === 0 && entityHints.length === 0) {
    return [];
  }
  const safeHops = Math.min(Math.max(Math.trunc(input.hops ?? 2), 1), 4);
  const limit = Math.min(Math.max(input.limit ?? 32, 1), 128);
  return await withNeo4j(config, async (session) => {
    const result =
      seedMemoryIds.length > 0
        ? await session.executeRead((tx) =>
            tx.run(
              `
              MATCH (seed:Memory {namespace: $namespace})
              WHERE seed.id IN $seedMemoryIds
              MATCH path = (seed)-[:MENTIONS]->(:Entity)-[:RELATED*1..${safeHops}]-(:Entity)<-[:MENTIONS]-(related:Memory {namespace: $namespace})
              WHERE NOT related.id IN $seedMemoryIds
              RETURN related.id AS memoryId, count(path) AS graphScore
              ORDER BY graphScore DESC
              LIMIT $limit
              `,
              {
                namespace: input.namespace,
                seedMemoryIds,
                limit: neo4j.int(limit),
              },
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
              LIMIT $limit
              `,
              {
                namespace: input.namespace,
                entityHints: entityHints.map((hint) => hint.toLowerCase()),
                limit: neo4j.int(limit),
              },
            ),
          );
    return result.records.map((record) => ({
      memoryId: record.get("memoryId") as string,
      graphScore: toNumber(record.get("graphScore")),
    }));
  });
}

function toNumber(value: unknown) {
  if (typeof value === "number") {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof value.toNumber === "function"
  ) {
    return value.toNumber();
  }
  return Number(value);
}

export type { GraphStore, GraphSyncJob };
