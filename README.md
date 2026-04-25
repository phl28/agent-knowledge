# Agent Knowledge Convex Component

Agent Knowledge is a Convex component for persistent agent memory. It uses Convex
tables as the source of truth, Convex vector search for semantic recall, and Neo4j
as an optional graph projection for relationship traversal.

The component has four core memory operations:

| Operation | Meaning |
| --- | --- |
| `remember` | Store raw memory, chunk it, embed it, extract graph facts, and enqueue graph sync. |
| `recall` | Retrieve memories through semantic, graph, or hybrid search. |
| `observe` | Record whether recalled memories helped. |
| `promote` | Reweight useful memories and relationships from observations. |

## Install

```bash
pnpm add convex-agent-knowledge
```

The package includes its runtime dependencies, including the AI SDK and Neo4j
driver. Install your model provider package separately. The examples below use
OpenAI:

```bash
pnpm add @ai-sdk/openai
```

Add the component to your Convex app:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import agentKnowledge from "convex-agent-knowledge/convex.config";

const app = defineApp();
app.use(agentKnowledge);

export default app;
```

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

Neo4j support runs from your app's own Node action, not inside the component:

```ts
// convex/knowledgeNode.ts
"use node";

import { openai } from "@ai-sdk/openai";
import { v } from "convex/values";
import { action } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { AgentKnowledge } from "convex-agent-knowledge";
import { createNeo4jGraphStore } from "convex-agent-knowledge/node";

const graph = createNeo4jGraphStore({
  uri: process.env.NEO4J_URI!,
  user: process.env.NEO4J_USER!,
  password: process.env.NEO4J_PASSWORD!,
  database: process.env.NEO4J_DATABASE,
});

const knowledge = new AgentKnowledge(components.agentKnowledge, {
  textEmbeddingModel: openai.embedding("text-embedding-3-small"),
  embeddingDimension: 1536,
  extractionModel: openai.chat("gpt-4o-mini"),
  graph,
});

export const recallHybrid = action({
  args: { namespace: v.string(), query: v.string() },
  handler: async (ctx, args) => {
    return await knowledge.recall(ctx, {
      namespace: args.namespace,
      query: args.query,
      searchType: "hybrid",
    });
  },
});
```

## Notes

- `remember` and semantic `recall` are intended to run from Convex actions because
  they call model providers and vector search.
- Neo4j integration is exported from `convex-agent-knowledge/node` and must
  run in your app's own `"use node"` action. Convex components cannot use
  `"use node"` internally.
- Component functions cannot read the app's environment variables. Pass Neo4j
  credentials into the client from the app side.
- Neo4j is a derived graph index. Convex stores canonical memories, chunks,
  entities, relationships, observations, and graph sync jobs.
- The default extractor uses the AI SDK when an `extractionModel` is provided. If
  not, a small heuristic extractor is used so local tests and prototypes still work.
