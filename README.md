# Agent Knowledge Convex Component

Pre-alpha package reservation release. The component skeleton is usable for
experimentation, but the API and storage model may change before a stable
release.

Agent Knowledge is a Convex component for persistent agent memory. It uses Convex
tables as the source of truth, Convex vector search for semantic recall, and Neo4j
as a graph projection for relationship traversal. The Neo4j connection is supplied
to the component as environment variables — the component runs the graph sync and
traversal internally, so your application code never touches the driver.

The component has four core memory operations:

| Operation  | Meaning                                                                            |
| ---------- | ---------------------------------------------------------------------------------- |
| `remember` | Store raw memory, chunk it, embed it, extract graph facts, and enqueue graph sync. |
| `recall`   | Retrieve memories through semantic, graph, or hybrid search.                       |
| `observe`  | Record whether recalled memories helped.                                           |
| `promote`  | Reweight useful memories and relationships from observations.                      |

## Install

```bash
pnpm add convex-agent-knowledge
```

The package includes its runtime dependencies, including the AI SDK. Neo4j is
reached over its HTTP Query API (no driver), so nothing extra is needed for the
graph. Install your model provider package separately. The examples below use
OpenAI:

```bash
pnpm add @ai-sdk/openai
```

Add the component to your Convex app and pass the Neo4j connection through the
component's environment variables (introduced in Convex 1.39, so this package
requires `convex >= 1.39.0`):

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import agentKnowledge from "convex-agent-knowledge/convex.config";

const app = defineApp({
  env: {
    NEO4J_URI: v.string(),
    NEO4J_USER: v.string(),
    NEO4J_PASSWORD: v.string(),
    NEO4J_DATABASE: v.optional(v.string()),
  },
});

app.use(agentKnowledge, {
  env: {
    NEO4J_URI: app.env.NEO4J_URI,
    NEO4J_USER: app.env.NEO4J_USER,
    NEO4J_PASSWORD: app.env.NEO4J_PASSWORD,
    NEO4J_DATABASE: app.env.NEO4J_DATABASE,
  },
});

export default app;
```

Set the values in your deployment (required env vars must be present before a
deploy succeeds):

```bash
npx convex env set NEO4J_URI neo4j+s://<your-db>.databases.neo4j.io
npx convex env set NEO4J_USER neo4j
npx convex env set NEO4J_PASSWORD ...
# NEO4J_DATABASE is optional (defaults to "neo4j")
```

The component talks to Neo4j over its
[HTTP Query API](https://neo4j.com/docs/query-api/current/) using `fetch`,
because Convex components run in the default V8 runtime (no Bolt driver). On
**Aura** this is enabled out of the box: set `NEO4J_URI` to your `neo4j+s://`
connection URI and the Query API endpoint is derived from the same host over
HTTPS.

For a **self-hosted** Neo4j, enable the HTTP connector and set `NEO4J_URI` to
that HTTP(S) endpoint directly (for example `https://your-host:7473`) — when
`NEO4J_URI` already starts with `http`/`https` it is used as the Query API
origin verbatim, rather than being derived from a Bolt URI.

## Usage

Semantic memory works from regular Convex actions:

```ts
// convex/knowledge.ts
import { openai } from "@ai-sdk/openai";
import { v } from "convex/values";
import { action, mutation } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { AgentKnowledge } from "convex-agent-knowledge";

const knowledge = new AgentKnowledge(components.agentKnowledge, {
  textEmbeddingModel: openai.embedding("text-embedding-3-small"),
  embeddingDimension: 1536,
  extractionModel: openai.chat("gpt-4o-mini"),
});

export const remember = action({
  args: { namespace: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    return await knowledge.remember(ctx, {
      namespace: args.namespace,
      text: args.text,
      source: { type: "conversation" },
    });
  },
});

export const recall = action({
  args: { namespace: v.string(), query: v.string() },
  handler: async (ctx, args) => {
    return await knowledge.recall(ctx, {
      namespace: args.namespace,
      query: args.query,
      searchType: "hybrid",
      limit: 8,
    });
  },
});

export const observe = mutation({
  args: {
    namespace: v.string(),
    memoryId: v.string(),
    outcome: v.union(v.literal("helpful"), v.literal("not_helpful"), v.literal("neutral")),
  },
  handler: async (ctx, args) => {
    await knowledge.observe(ctx, {
      namespace: args.namespace,
      memoryId: args.memoryId,
      query: "",
      outcome: args.outcome,
    });
  },
});
```

Hybrid `recall` (semantic + graph) needs no extra setup. The component runs the
Neo4j traversal internally with the credentials you configured, fuses the graph
and vector scores, and returns ranked cards:

```ts
export const recallHybrid = action({
  args: {
    namespace: v.string(),
    query: v.string(),
    entityHints: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    return await knowledge.recall(ctx, {
      namespace: args.namespace,
      query: args.query,
      searchType: "hybrid",
      ...(args.entityHints === undefined ? {} : { entityHints: args.entityHints }),
    });
  },
});
```

## Notes

- `remember` and `recall` are intended to run from Convex actions because they
  call model providers and vector search.
- Graph sync to Neo4j happens inside the component: each write enqueues a sync
  job and the component drains it via the Neo4j HTTP Query API (`fetch`, default
  runtime — components cannot use `"use node"`), with internal exponential-backoff
  retries and a sweep cron, so a Neo4j outage never leaves orphaned data. Your
  application never drives the sync or touches a Neo4j connection.
- Neo4j is a derived graph index. Convex stores canonical memories, chunks,
  entities, relationships, observations, and graph sync jobs.
- The default extractor uses the AI SDK when an `extractionModel` is provided. If
  not, a small heuristic extractor is used so local tests and prototypes still work.
