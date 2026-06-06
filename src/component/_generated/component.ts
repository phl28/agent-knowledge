/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    actions: {
      recall: FunctionReference<
        "action",
        "internal",
        {
          agentId?: string;
          embeddingDimension: number;
          limit?: number;
          namespace: string;
          query: string;
          queryEmbedding?: Array<number>;
          searchType?: "semantic" | "graph" | "hybrid";
        },
        {
          results: Array<{
            agentId?: string;
            entities: Array<{
              confidence: number;
              description?: string;
              externalId: string;
              name: string;
              type: string;
            }>;
            graphScore?: number;
            importance: number;
            key?: string;
            memoryId: string;
            metadata?: any;
            namespace: string;
            relationships: Array<{
              confidence: number;
              description?: string;
              fromEntityExternalId: string;
              toEntityExternalId: string;
              type: string;
              weight: number;
            }>;
            score: number;
            semanticScore?: number;
            source?: {
              id?: string;
              title?: string;
              type: string;
              url?: string;
            };
            text: string;
          }>;
        },
        Name
      >;
    };
    mutations: {
      deleteByKey: FunctionReference<
        "mutation",
        "internal",
        { key: string; namespace: string },
        { deleted: boolean; graphSyncJobId?: string; memoryId?: string },
        Name
      >;
      forgetNamespace: FunctionReference<
        "mutation",
        "internal",
        { graphJobEnqueued?: boolean; namespace: string },
        { deletedMemories: number; isDone: boolean },
        Name
      >;
      markGraphSyncJobFailed: FunctionReference<
        "mutation",
        "internal",
        { error: string; jobId: string },
        null,
        Name
      >;
      markGraphSyncJobRunning: FunctionReference<
        "mutation",
        "internal",
        { jobId: string },
        null,
        Name
      >;
      markGraphSyncJobSucceeded: FunctionReference<
        "mutation",
        "internal",
        { jobId: string },
        null,
        Name
      >;
      observe: FunctionReference<
        "mutation",
        "internal",
        {
          feedback?: string;
          memoryId: string;
          metadata?: any;
          namespace: string;
          outcome: "helpful" | "not_helpful" | "neutral";
          query: string;
        },
        null,
        Name
      >;
      promote: FunctionReference<
        "mutation",
        "internal",
        { limit?: number; namespace: string },
        { promoted: number },
        Name
      >;
      remember: FunctionReference<
        "mutation",
        "internal",
        {
          agentId?: string;
          chunks: Array<{
            embedding: Array<number>;
            metadata?: any;
            summary?: string;
            text: string;
            tokenCount?: number;
          }>;
          contentHash: string;
          embeddingDimension: number;
          entities: Array<{
            aliases?: Array<string>;
            confidence?: number;
            description?: string;
            externalId: string;
            metadata?: any;
            name: string;
            type: string;
          }>;
          importance?: number;
          key?: string;
          metadata?: any;
          namespace: string;
          relationships: Array<{
            confidence?: number;
            description?: string;
            fromEntityExternalId: string;
            metadata?: any;
            toEntityExternalId: string;
            type: string;
            weight?: number;
          }>;
          source?: { id?: string; title?: string; type: string; url?: string };
          text: string;
        },
        {
          chunkCount: number;
          entityCount: number;
          graphSyncJobId: string;
          memoryId: string;
          relationshipCount: number;
          replacedMemoryId?: string;
        },
        Name
      >;
    };
    queries: {
      fetchMemoryCards: FunctionReference<
        "query",
        "internal",
        {
          matches: Array<{
            graphScore?: number;
            memoryId: string;
            score: number;
            semanticScore?: number;
          }>;
        },
        Array<{
          agentId?: string;
          entities: Array<{
            confidence: number;
            description?: string;
            externalId: string;
            name: string;
            type: string;
          }>;
          graphScore?: number;
          importance: number;
          key?: string;
          memoryId: string;
          metadata?: any;
          namespace: string;
          relationships: Array<{
            confidence: number;
            description?: string;
            fromEntityExternalId: string;
            toEntityExternalId: string;
            type: string;
            weight: number;
          }>;
          score: number;
          semanticScore?: number;
          source?: { id?: string; title?: string; type: string; url?: string };
          text: string;
        }>,
        Name
      >;
      getMemory: FunctionReference<
        "query",
        "internal",
        { memoryId: string },
        {
          agentId?: string;
          entities: Array<{
            confidence: number;
            description?: string;
            externalId: string;
            name: string;
            type: string;
          }>;
          graphScore?: number;
          importance: number;
          key?: string;
          memoryId: string;
          metadata?: any;
          namespace: string;
          relationships: Array<{
            confidence: number;
            description?: string;
            fromEntityExternalId: string;
            toEntityExternalId: string;
            type: string;
            weight: number;
          }>;
          score: number;
          semanticScore?: number;
          source?: { id?: string; title?: string; type: string; url?: string };
          text: string;
        } | null,
        Name
      >;
      listMemories: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit?: number; namespace: string },
        {
          continueCursor: string | null;
          isDone: boolean;
          page: Array<{
            agentId?: string;
            entities: Array<{
              confidence: number;
              description?: string;
              externalId: string;
              name: string;
              type: string;
            }>;
            graphScore?: number;
            importance: number;
            key?: string;
            memoryId: string;
            metadata?: any;
            namespace: string;
            relationships: Array<{
              confidence: number;
              description?: string;
              fromEntityExternalId: string;
              toEntityExternalId: string;
              type: string;
              weight: number;
            }>;
            score: number;
            semanticScore?: number;
            source?: {
              id?: string;
              title?: string;
              type: string;
              url?: string;
            };
            text: string;
          }>;
        },
        Name
      >;
      listPendingGraphSyncJobs: FunctionReference<
        "query",
        "internal",
        { limit: number },
        Array<{
          attempts: number;
          jobId: string;
          namespace: string;
          operation: string;
          payload: any;
        }>,
        Name
      >;
    };
  };
