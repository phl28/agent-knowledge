# Agent Knowledge Convex Component

Agent Knowledge is a Convex component for persistent agent memory. It uses Convex
tables as the source of truth, Convex vector search for semantic recall, and Neo4j
as an optional graph projection for relationship traversal.

The lifecycle is inspired by Cognee, but the public API is agent-native:

| Cognee idea | Agent Knowledge API | Meaning |
| --- | --- | --- |
| `add + cognify` | `remember` | Store raw memory, chunk it, embed it, extract graph facts, and enqueue graph sync. |
| `search` | `recall` | Retrieve memories through semantic, graph, or hybrid search. |
| `memify` feedback input | `observe` | Record whether recalled memories helped. |
| `memify` enrichment | `promote` | Reweight useful memories and relationships from observations. |

## Install

```bash
npm install @convex-dev/agent-knowledge neo4j-driver ai
```

Add the component to your Convex app:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import agentKnowledge from "@convex-dev/agent-knowledge/convex.config.js";

const app = defineApp();
app.use(agentKnowledge);

export default app;
```

## Usage

```ts
// convex/knowledge.ts
import { openai } from "@ai-sdk/openai";
import { v } from "convex/values";
import { action, mutation } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { AgentKnowledge } from "@convex-dev/agent-knowledge";

const knowledge = new AgentKnowledge(components.agentKnowledge, {
  textEmbeddingModel: openai.embedding("text-embedding-3-small"),
  embeddingDimension: 1536,
  extractionModel: openai.chat("gpt-4o-mini"),
  neo4j: {
    uri: process.env.NEO4J_URI!,
    user: process.env.NEO4J_USER!,
    password: process.env.NEO4J_PASSWORD!,
    database: process.env.NEO4J_DATABASE,
  },
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

## Notes

- `remember` and `recall` are intended to run from Convex actions because they call
  model providers and vector search.
- Component functions cannot read the app's environment variables. Pass Neo4j
  credentials into the client from the app side.
- Neo4j is a derived graph index. Convex stores canonical memories, chunks,
  entities, relationships, observations, and graph sync jobs.
- The default extractor uses the AI SDK when an `extractionModel` is provided. If
  not, a small heuristic extractor is used so local tests and prototypes still work.
