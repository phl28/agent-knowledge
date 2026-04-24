import { embed, embedMany } from "ai";
import { chunkText, type ChunkTextOptions } from "./chunking.js";
import { extractKnowledge } from "./extraction.js";
import { stableHash } from "./hash.js";
import type {
  AgentKnowledgeComponent,
  ChunkInput,
  ConvexActionCtx,
  ConvexMutationCtx,
  ConvexQueryCtx,
  EmbeddedChunkInput,
  ExtractedKnowledge,
  MemoryCard,
  MemorySource,
  Neo4jConfig,
  SearchType,
} from "./types.js";

export type AgentKnowledgeOptions = {
  textEmbeddingModel?: unknown;
  embeddingDimension: number;
  extractionModel?: unknown;
  neo4j?: Neo4jConfig;
  chunking?: ChunkTextOptions;
  extract?: (input: {
    namespace: string;
    text: string;
    chunks: ChunkInput[];
  }) => Promise<ExtractedKnowledge>;
};

export type RememberInput = {
  namespace: string;
  key?: string;
  agentId?: string;
  text: string;
  source?: MemorySource;
  metadata?: unknown;
  importance?: number;
  chunks?: ChunkInput[];
  extracted?: ExtractedKnowledge;
};

export type RecallInput = {
  namespace: string;
  query: string;
  searchType?: SearchType;
  limit?: number;
  agentId?: string;
  entityHints?: string[];
  queryEmbedding?: number[];
  neo4j?: Neo4jConfig;
};

export type ObserveInput = {
  namespace: string;
  memoryId: string;
  query: string;
  outcome: "helpful" | "not_helpful" | "neutral";
  feedback?: string;
  metadata?: unknown;
};

export class AgentKnowledge {
  constructor(
    private readonly component: AgentKnowledgeComponent,
    private readonly options: AgentKnowledgeOptions,
  ) {}

  async remember(ctx: ConvexActionCtx, input: RememberInput) {
    const chunks = input.chunks ?? chunkText(input.text, this.options.chunking);
    if (chunks.length === 0) {
      throw new Error("Cannot remember empty text");
    }
    const embeddedChunks = await this.embedChunks(chunks);
    const extracted =
      input.extracted ??
      (this.options.extract
        ? await this.options.extract({
            namespace: input.namespace,
            text: input.text,
            chunks,
          })
        : await extractKnowledge({
            namespace: input.namespace,
            text: input.text,
            model: this.options.extractionModel,
          }));

    const mutationArgs = {
      namespace: input.namespace,
      ...(input.key === undefined ? {} : { key: input.key }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      text: input.text,
      contentHash: stableHash(`${input.namespace}:${input.text}`),
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      embeddingDimension: this.options.embeddingDimension,
      chunks: embeddedChunks,
      entities: extracted.entities,
      relationships: extracted.relationships,
    };

    const result = await ctx.runMutation(this.component.mutations.remember, mutationArgs);
    if (this.options.neo4j) {
      await this.syncGraph(ctx, { limit: 10 });
    }
    return result as {
      memoryId: string;
      replacedMemoryId?: string;
      chunkCount: number;
      entityCount: number;
      relationshipCount: number;
      graphSyncJobId: string;
    };
  }

  async recall(ctx: ConvexActionCtx, input: RecallInput) {
    const queryEmbedding =
      input.queryEmbedding ??
      (input.searchType === "graph" ? undefined : await this.embedQuery(input.query));
    const result = await ctx.runAction(this.component.actions.recall, {
      namespace: input.namespace,
      query: input.query,
      ...(queryEmbedding === undefined ? {} : { queryEmbedding }),
      embeddingDimension: this.options.embeddingDimension,
      ...(input.searchType === undefined ? {} : { searchType: input.searchType }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.entityHints === undefined ? {} : { entityHints: input.entityHints }),
      ...(input.neo4j ?? this.options.neo4j
        ? { neo4j: input.neo4j ?? this.options.neo4j }
        : {}),
    });
    return result as { results: MemoryCard[] };
  }

  async observe(ctx: ConvexMutationCtx, input: ObserveInput) {
    return await ctx.runMutation(this.component.mutations.observe, {
      namespace: input.namespace,
      memoryId: input.memoryId,
      query: input.query,
      outcome: input.outcome,
      ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
  }

  async promote(
    ctx: ConvexMutationCtx,
    input: { namespace: string; limit?: number },
  ) {
    return (await ctx.runMutation(this.component.mutations.promote, {
      namespace: input.namespace,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })) as { promoted: number };
  }

  async deleteByKey(
    ctx: ConvexMutationCtx,
    input: { namespace: string; key: string },
  ) {
    return (await ctx.runMutation(this.component.mutations.deleteByKey, {
      namespace: input.namespace,
      key: input.key,
    })) as {
      deleted: boolean;
      memoryId?: string;
      graphSyncJobId?: string;
    };
  }

  async getMemory(ctx: ConvexQueryCtx, input: { memoryId: string }) {
    return (await ctx.runQuery(this.component.queries.getMemory, {
      memoryId: input.memoryId,
    })) as MemoryCard | null;
  }

  async listMemories(
    ctx: ConvexQueryCtx,
    input: { namespace: string; limit?: number; cursor?: string },
  ) {
    return (await ctx.runQuery(this.component.queries.listMemories, {
      namespace: input.namespace,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    })) as {
      page: MemoryCard[];
      continueCursor: string | null;
      isDone: boolean;
    };
  }

  async syncGraph(ctx: ConvexActionCtx, input?: { neo4j?: Neo4jConfig; limit?: number }) {
    const neo4j = input?.neo4j ?? this.options.neo4j;
    if (!neo4j) {
      return { succeeded: 0, failed: 0 };
    }
    return (await ctx.runAction(this.component.actions.syncGraph, {
      neo4j,
      ...(input?.limit === undefined ? {} : { limit: input.limit }),
    })) as { succeeded: number; failed: number };
  }

  private async embedChunks(chunks: ChunkInput[]): Promise<EmbeddedChunkInput[]> {
    if (!this.options.textEmbeddingModel) {
      throw new Error("AgentKnowledge requires textEmbeddingModel to remember text");
    }
    const result = await embedMany({
      model: this.options.textEmbeddingModel as never,
      values: chunks.map((chunk) => chunk.text),
    });
    return chunks.map((chunk, index) => {
      const embedding = result.embeddings[index];
      if (!embedding) {
        throw new Error(`Missing embedding for chunk ${index}`);
      }
      if (embedding.length !== this.options.embeddingDimension) {
        throw new Error(
          `Embedding dimension ${embedding.length} does not match configured dimension ${this.options.embeddingDimension}`,
        );
      }
      return {
        ...chunk,
        embedding,
      };
    });
  }

  private async embedQuery(query: string) {
    if (!this.options.textEmbeddingModel) {
      throw new Error(
        "AgentKnowledge requires textEmbeddingModel for semantic or hybrid recall",
      );
    }
    const result = await embed({
      model: this.options.textEmbeddingModel as never,
      value: query,
    });
    if (result.embedding.length !== this.options.embeddingDimension) {
      throw new Error(
        `Embedding dimension ${result.embedding.length} does not match configured dimension ${this.options.embeddingDimension}`,
      );
    }
    return result.embedding;
  }
}

export { chunkText } from "./chunking.js";
export { extractKnowledge, heuristicExtractKnowledge } from "./extraction.js";
export type {
  ChunkInput,
  EmbeddedChunkInput,
  ExtractedEntity,
  ExtractedKnowledge,
  ExtractedRelationship,
  MemoryCard,
  MemorySource,
  Neo4jConfig,
  SearchType,
} from "./types.js";
