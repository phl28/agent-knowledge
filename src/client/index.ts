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
  SearchType,
} from "./types.js";

export type AgentKnowledgeOptions = {
  textEmbeddingModel?: unknown;
  embeddingDimension: number;
  extractionModel?: unknown;
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
  // Entity names that seed graph traversal when there are no semantic results
  // to expand from (i.e. searchType "graph", or "hybrid" with an empty semantic
  // set). When semantic search returns seeds, expansion starts from those and
  // these hints are not used.
  entityHints?: string[];
  queryEmbedding?: number[];
  // Re-rank the final results with MMR (lexical diversity) so recall does not
  // return near-duplicate memories about the same fact.
  diversify?: boolean;
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
    const searchType = input.searchType ?? "hybrid";
    const limit = input.limit ?? 10;
    // Embedding happens client-side because the embedding model lives in the
    // caller's code; the component handles vector search, graph expansion, and
    // score fusion internally and returns the final ranked cards.
    const queryEmbedding =
      input.queryEmbedding ??
      (searchType === "graph" ? undefined : await this.embedQuery(input.query));
    return (await ctx.runAction(this.component.actions.recall, {
      namespace: input.namespace,
      query: input.query,
      ...(queryEmbedding === undefined ? {} : { queryEmbedding }),
      embeddingDimension: this.options.embeddingDimension,
      searchType,
      limit,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.entityHints === undefined ? {} : { entityHints: input.entityHints }),
      ...(input.diversify === undefined ? {} : { diversify: input.diversify }),
    })) as { results: MemoryCard[] };
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

  async promote(ctx: ConvexMutationCtx, input: { namespace: string; limit?: number }) {
    return (await ctx.runMutation(this.component.mutations.promote, {
      namespace: input.namespace,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })) as { promoted: number };
  }

  async deleteByKey(ctx: ConvexMutationCtx, input: { namespace: string; key: string }) {
    return (await ctx.runMutation(this.component.mutations.deleteByKey, {
      namespace: input.namespace,
      key: input.key,
    })) as {
      deleted: boolean;
      memoryId?: string;
      graphSyncJobId?: string;
    };
  }

  // Purge all of a namespace's data (e.g. account deletion). The component
  // mutation deletes Convex rows in bounded batches, rescheduling itself until
  // the namespace is empty, and enqueues a forget_namespace graph sync job that
  // the component drains internally with the same retry semantics as every
  // other graph operation, so a Neo4j outage never leaves orphaned data.
  // deletedMemories counts the first batch — when isDone is false the remainder
  // is purged in the background.
  async forgetNamespace(ctx: ConvexMutationCtx, input: { namespace: string }) {
    return (await ctx.runMutation(this.component.mutations.forgetNamespace, {
      namespace: input.namespace,
    })) as { deletedMemories: number; isDone: boolean };
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
      throw new Error("AgentKnowledge requires textEmbeddingModel for semantic or hybrid recall");
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
  SearchType,
} from "./types.js";
