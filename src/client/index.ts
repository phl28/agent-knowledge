import { embed, embedMany } from "ai";
import { chunkText, type ChunkTextOptions } from "./chunking.js";
import { extractKnowledge } from "./extraction.js";
import { stableHash } from "./hash.js";
import { fuseMemoryScores } from "../shared/ranking.js";
import type {
  AgentKnowledgeComponent,
  ChunkInput,
  ConvexActionCtx,
  ConvexMutationCtx,
  ConvexQueryCtx,
  EmbeddedChunkInput,
  ExtractedKnowledge,
  GraphStore,
  GraphSyncJob,
  MemoryCard,
  MemorySource,
  SearchType,
} from "./types.js";

export type AgentKnowledgeOptions = {
  textEmbeddingModel?: unknown;
  embeddingDimension: number;
  extractionModel?: unknown;
  graph?: GraphStore;
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
  graph?: GraphStore;
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
    if (this.options.graph) {
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
    const searchType = input.searchType ?? "hybrid";
    const limit = input.limit ?? 10;
    const queryEmbedding =
      input.queryEmbedding ??
      (searchType === "graph" ? undefined : await this.embedQuery(input.query));
    const semanticResult =
      searchType === "graph"
        ? { results: [] as MemoryCard[] }
        : ((await ctx.runAction(this.component.actions.recall, {
            namespace: input.namespace,
            query: input.query,
            ...(queryEmbedding === undefined ? {} : { queryEmbedding }),
            embeddingDimension: this.options.embeddingDimension,
            searchType,
            limit,
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
          })) as { results: MemoryCard[] });

    const graph = input.graph ?? this.options.graph;
    if (!graph || searchType === "semantic") {
      return semanticResult;
    }

    const graphScores = await graph.expand({
      namespace: input.namespace,
      seedMemoryIds: semanticResult.results.map((card) => card.memoryId),
      hops: 2,
      limit: Math.max(limit * 4, 16),
      ...(input.entityHints === undefined ? {} : { entityHints: input.entityHints }),
    });
    const graphCards =
      graphScores.length === 0
        ? []
        : ((await ctx.runQuery(this.component.queries.fetchMemoryCards, {
            matches: graphScores.map((score) => ({
              memoryId: score.memoryId,
              score: score.graphScore,
              graphScore: score.graphScore,
            })),
          })) as MemoryCard[]);

    return {
      results: fuseMemoryScores(semanticResult.results, graphCards, { limit }),
    };
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

  // Purge all of a namespace's memories from Convex and, when a graph is
  // configured, from Neo4j too. Use for clearing a user's memory (e.g. account
  // deletion). Runs in an action since the graph cleanup is a network call.
  async forgetNamespace(ctx: ConvexActionCtx, input: { namespace: string }) {
    const result = (await ctx.runMutation(this.component.mutations.forgetNamespace, {
      namespace: input.namespace,
    })) as { deletedMemories: number };
    const graph = this.options.graph;
    if (graph?.forgetNamespace) {
      await graph.forgetNamespace(input.namespace);
    }
    return result;
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

  async syncGraph(ctx: ConvexActionCtx, input?: { graph?: GraphStore; limit?: number }) {
    const graph = input?.graph ?? this.options.graph;
    if (!graph) {
      return { succeeded: 0, failed: 0 };
    }
    const jobs = (await ctx.runQuery(this.component.queries.listPendingGraphSyncJobs, {
      limit: input?.limit ?? 10,
    })) as GraphSyncJob[];
    let succeeded = 0;
    let failed = 0;
    for (const job of jobs) {
      await ctx.runMutation(this.component.mutations.markGraphSyncJobRunning, {
        jobId: job.jobId,
      });
      try {
        await graph.syncJob(job);
        await ctx.runMutation(this.component.mutations.markGraphSyncJobSucceeded, {
          jobId: job.jobId,
        });
        succeeded += 1;
      } catch (error) {
        await ctx.runMutation(this.component.mutations.markGraphSyncJobFailed, {
          jobId: job.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
        failed += 1;
      }
    }
    return { succeeded, failed };
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
  GraphExpandInput,
  GraphMemoryScore,
  GraphStore,
  GraphSyncJob,
  MemoryCard,
  MemorySource,
  Neo4jConfig,
  SearchType,
} from "./types.js";
