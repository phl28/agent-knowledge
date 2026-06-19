import { v } from "convex/values";
import { anyApi } from "convex/server";
import { internalAction } from "./_generated/server.js";

// Cross-function references go through `anyApi` (what the generated `internal`
// resolves to at runtime) rather than the typed `internal` to avoid a circular
// type reference through this module's own generated api.
const ref = anyApi as any;

// Retry policy for graph sync jobs. The drain claims due jobs, runs them
// against Neo4j, and reschedules failures with exponential backoff until they
// succeed or exhaust MAX_ATTEMPTS, after which they are dead-lettered (left in
// the "failed" state with their last error). All of this is internal — the app
// installing the component never drives it.
const MAX_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 1000;
const BACKOFF_BASE = 2;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const DRAIN_BATCH = 25;

type Neo4jHttp = { url: string; authHeader: string };

function neo4jHttpFromEnv(): Neo4jHttp {
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
  return {
    url: queryApiUrl(uri, database),
    authHeader: `Basic ${btoa(`${user}:${password}`)}`,
  };
}

// Neo4j is reached over its HTTP Query API (the component runs in Convex's
// default V8 runtime, which has fetch but not the Bolt driver). Aura — and any
// neo4j+s://host URI — exposes the Query API over HTTPS on the same host, so we
// derive the endpoint from the bolt-style URI. A self-hosted instance whose
// HTTP connector is on a different host/port must instead set NEO4J_URI to that
// HTTP(S) URL directly (e.g. https://host:7473), which is used verbatim.
function queryApiUrl(uri: string, database: string): string {
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

function backoffMs(attempts: number) {
  const exponential = INITIAL_BACKOFF_MS * BACKOFF_BASE ** Math.max(0, attempts - 1);
  const capped = Math.min(exponential, MAX_BACKOFF_MS);
  // Jitter so a batch of simultaneous failures doesn't retry in lockstep.
  return Math.round(capped + capped * 0.2 * Math.random());
}

// Drain due graph sync jobs against Neo4j. Triggered after each write that
// enqueues a job, by a self-reschedule when a batch fills, and by the retry
// cron as a safety net.
export const processPendingJobs = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ succeeded: v.number(), failed: v.number() }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? DRAIN_BATCH;
    const http = neo4jHttpFromEnv();
    const claimed = await ctx.runMutation(ref.mutations.claimGraphSyncJobs, { limit });

    let succeeded = 0;
    let failed = 0;
    for (const job of claimed) {
      try {
        await runSyncJob(http, job);
        await ctx.runMutation(ref.mutations.completeGraphSyncJob, { jobId: job.jobId });
        succeeded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.runMutation(ref.mutations.completeGraphSyncJob, {
          jobId: job.jobId,
          error: message,
          ...(job.attempts >= MAX_ATTEMPTS
            ? {}
            : { retryAt: Date.now() + backoffMs(job.attempts) }),
        });
        failed += 1;
      }
    }

    if (claimed.length >= limit) {
      await ctx.scheduler.runAfter(0, ref.graph.processPendingJobs, { limit });
    }
    return { succeeded, failed };
  },
});

// Graph traversal for hybrid recall. Called from the recall action with the
// memories returned by semantic search as seeds.
export const expandGraph = internalAction({
  args: {
    namespace: v.string(),
    seedMemoryIds: v.array(v.string()),
    entityHints: v.optional(v.array(v.string())),
    hops: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.object({ memoryId: v.string(), graphScore: v.number() })),
  handler: async (ctx, args) => {
    const http = neo4jHttpFromEnv();
    return await expand(http, args);
  },
});

type GraphSyncJob = {
  jobId: string;
  namespace: string;
  operation: string;
  attempts: number;
  payload: unknown;
};

async function runSyncJob(http: Neo4jHttp, job: GraphSyncJob) {
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

// One auto-commit Cypher statement per request against the Query API v2. Errors
// (HTTP status or an `errors` array in the body) throw so the caller's retry
// queue handles them.
async function runCypher(http: Neo4jHttp, statement: string, parameters?: Record<string, unknown>) {
  const response = await fetch(http.url, {
    method: "POST",
    headers: {
      Authorization: http.authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(parameters ? { statement, parameters } : { statement }),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: { fields?: string[]; values?: unknown[][] };
    errors?: Array<{ code?: string; message?: string }>;
  } | null;
  const errors = body?.errors;
  if (!response.ok || (Array.isArray(errors) && errors.length > 0)) {
    const detail = Array.isArray(errors)
      ? errors.map((error) => error.message ?? error.code).join("; ")
      : `${response.status} ${response.statusText}`;
    throw new Error(`Neo4j Query API error: ${detail}`);
  }
  return body;
}

function recordsOf(
  body: { data?: { fields?: string[]; values?: unknown[][] } } | null,
): Array<Record<string, unknown>> {
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

type GraphExpandInput = {
  namespace: string;
  seedMemoryIds: string[];
  entityHints?: string[];
  hops?: number;
  limit?: number;
};

async function expand(http: Neo4jHttp, input: GraphExpandInput) {
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
  return recordsOf(body).map((record) => ({
    memoryId: record.memoryId as string,
    graphScore: Number(record.graphScore ?? 0),
  }));
}
