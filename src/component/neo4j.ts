// Neo4j HTTP Query API access for the component. Components run in Convex's
// default V8 runtime (fetch, no Bolt driver), so all access goes over the Query
// API v2. This module has no Convex imports, so its pure pieces (queryApiUrl,
// backoffMs, recordsOf) are unit-tested in isolation.

// Retry policy for graph sync jobs: exponential backoff with jitter, capped,
// and dead-lettered after MAX_ATTEMPTS.
export const MAX_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 1000;
const BACKOFF_BASE = 2;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export type Neo4jHttp = { url: string; authHeader: string };

export function neo4jHttpFromEnv(): Neo4jHttp {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error(
      "agentKnowledge: NEO4J_URI, NEO4J_USER and NEO4J_PASSWORD must be provided via " +
        "app.use(agentKnowledge, { env: { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } }).",
    );
  }
  const database = process.env.NEO4J_DATABASE ?? "neo4j";
  return { url: queryApiUrl(uri, database), authHeader: basicAuth(user, password) };
}

// Aura (and any neo4j+s://host URI) exposes the Query API over HTTPS on the same
// host, so we derive the endpoint from the bolt-style URI. A self-hosted
// instance whose HTTP connector is on a different host/port must instead set
// NEO4J_URI to that HTTP(S) URL directly (e.g. https://host:7473), which is used
// verbatim.
export function queryApiUrl(uri: string, database: string): string {
  const trimmed = uri.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) {
    return `${trimmed}/db/${database}/query/v2`;
  }
  const host = trimmed
    .replace(/^[a-z0-9+.-]+:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .split("@")
    .pop()!
    .split(":")[0]!;
  return `https://${host}/db/${database}/query/v2`;
}

// UTF-8-safe HTTP Basic auth: encode to bytes before base64 so non-Latin1
// passwords don't throw in btoa.
function basicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `Basic ${btoa(binary)}`;
}

export function backoffMs(attempts: number) {
  const exponential = INITIAL_BACKOFF_MS * BACKOFF_BASE ** Math.max(0, attempts - 1);
  const capped = Math.min(exponential, MAX_BACKOFF_MS);
  // Jitter so a batch of simultaneous failures doesn't retry in lockstep.
  return Math.round(capped + capped * 0.2 * Math.random());
}

type QueryApiBody = {
  data?: { fields?: string[]; values?: unknown[][] };
  errors?: Array<{ code?: string; message?: string }>;
} | null;

// One auto-commit Cypher statement per request against the Query API v2. Errors
// (HTTP status or an `errors` array in the body) throw so the caller's retry
// queue handles them.
async function runCypher(
  http: Neo4jHttp,
  statement: string,
  parameters?: Record<string, unknown>,
): Promise<QueryApiBody> {
  const response = await fetch(http.url, {
    method: "POST",
    headers: {
      Authorization: http.authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(parameters ? { statement, parameters } : { statement }),
  });
  const body = (await response.json().catch(() => null)) as QueryApiBody;
  const errors = body?.errors;
  if (!response.ok || (Array.isArray(errors) && errors.length > 0)) {
    const detail = Array.isArray(errors)
      ? errors.map((error) => error.message ?? error.code).join("; ")
      : `${response.status} ${response.statusText}`;
    throw new Error(`Neo4j Query API error: ${detail}`);
  }
  return body;
}

export function recordsOf(body: QueryApiBody): Array<Record<string, unknown>> {
  const fields = body?.data?.fields ?? [];
  const values = body?.data?.values ?? [];
  return values.map((row) => {
    const record: Record<string, unknown> = {};
    fields.forEach((field, index) => {
      record[field] = row[index];
    });
    return record;
  });
}

export type GraphSyncJob = {
  jobId: string;
  namespace: string;
  operation: string;
  attempts: number;
  payload: unknown;
};

export async function runSyncJob(http: Neo4jHttp, job: GraphSyncJob) {
  if (job.operation === "upsert_memory") {
    await upsertMemoryGraph(http, job.payload);
  } else if (job.operation === "delete_memory") {
    await deleteMemoryGraph(http, job.payload);
  } else if (job.operation === "promote_memory") {
    await promoteMemoryGraph(http, job.payload);
  } else if (job.operation === "forget_namespace") {
    await forgetNamespaceGraph(http, job.payload);
  } else {
    throw new Error(`Unsupported graph sync operation ${job.operation}`);
  }
}

async function forgetNamespaceGraph(http: Neo4jHttp, payload: unknown) {
  const { namespace } = payload as { namespace: string };
  await runCypher(http, "MATCH (n {namespace: $namespace}) DETACH DELETE n", { namespace });
}

async function upsertMemoryGraph(http: Neo4jHttp, payload: unknown) {
  const graphPayload = payload as {
    memory: Record<string, unknown> & {
      id: string;
      namespace: string;
      importance?: number;
    };
    entities?: Array<Record<string, unknown>>;
    relationships?: Array<Record<string, unknown>>;
  };
  await runCypher(
    http,
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
  );

  await runCypher(
    http,
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
  );
}

async function deleteMemoryGraph(http: Neo4jHttp, payload: unknown) {
  const graphPayload = payload as { memoryId: string; namespace: string };
  await runCypher(
    http,
    `
    MATCH (m:Memory {id: $memoryId, namespace: $namespace})
    DETACH DELETE m
    `,
    graphPayload,
  );
}

async function promoteMemoryGraph(http: Neo4jHttp, payload: unknown) {
  const graphPayload = payload as {
    memoryId: string;
    namespace: string;
    importance: number;
    observationScore: number;
  };
  await runCypher(
    http,
    `
    MATCH (m:Memory {id: $memoryId, namespace: $namespace})
    SET m.importance = $importance,
        m.observationScore = $observationScore,
        m.updatedAt = timestamp()
    `,
    graphPayload,
  );
}

export type GraphExpandInput = {
  namespace: string;
  seedMemoryIds: string[];
  entityHints?: string[];
  hops?: number;
  limit?: number;
};

export async function expand(http: Neo4jHttp, input: GraphExpandInput) {
  const seedMemoryIds = input.seedMemoryIds;
  const entityHints = input.entityHints ?? [];
  if (seedMemoryIds.length === 0 && entityHints.length === 0) {
    return [];
  }
  const safeHops = Math.min(Math.max(Math.trunc(input.hops ?? 2), 1), 4);
  const limit = Math.min(Math.max(input.limit ?? 32, 1), 128);
  const body =
    seedMemoryIds.length > 0
      ? await runCypher(
          http,
          `
          MATCH (seed:Memory {namespace: $namespace})
          WHERE seed.id IN $seedMemoryIds
          MATCH path = (seed)-[:MENTIONS]->(:Entity)-[:RELATED*1..${safeHops}]-(:Entity)<-[:MENTIONS]-(related:Memory {namespace: $namespace})
          WHERE NOT related.id IN $seedMemoryIds
          RETURN related.id AS memoryId, count(path) AS graphScore
          ORDER BY graphScore DESC
          LIMIT toInteger($limit)
          `,
          { namespace: input.namespace, seedMemoryIds, limit },
        )
      : await runCypher(
          http,
          `
          MATCH (seed:Entity {namespace: $namespace})
          WHERE toLower(seed.name) IN $entityHints
          MATCH path = (seed)-[:RELATED*0..${safeHops}]-(:Entity)<-[:MENTIONS]-(related:Memory {namespace: $namespace})
          RETURN related.id AS memoryId, count(path) AS graphScore
          ORDER BY graphScore DESC
          LIMIT toInteger($limit)
          `,
          {
            namespace: input.namespace,
            entityHints: entityHints.map((hint) => hint.toLowerCase()),
            limit,
          },
        );
  const counts = recordsOf(body).map((record) => ({
    memoryId: record.memoryId as string,
    count: Number(record.graphScore ?? 0),
  }));
  // count(path) is an unbounded integer; normalize to [0, 1] relative to the
  // strongest hit in this result set so graph scores are comparable to the
  // semantic cosine scores fusion weights them against.
  const max = counts.reduce((m, score) => Math.max(m, score.count), 0);
  return counts.map((score) => ({
    memoryId: score.memoryId,
    graphScore: max > 0 ? score.count / max : 0,
  }));
}
