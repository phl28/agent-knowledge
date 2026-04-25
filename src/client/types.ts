export type SearchType = "semantic" | "graph" | "hybrid";

export type MemorySource = {
  type: string;
  id?: string;
  url?: string;
  title?: string;
};

export type ExtractedEntity = {
  externalId: string;
  name: string;
  type: string;
  description?: string;
  aliases?: string[];
  confidence?: number;
  metadata?: unknown;
};

export type ExtractedRelationship = {
  fromEntityExternalId: string;
  toEntityExternalId: string;
  type: string;
  description?: string;
  confidence?: number;
  weight?: number;
  metadata?: unknown;
};

export type ExtractedKnowledge = {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
};

export type ChunkInput = {
  text: string;
  summary?: string;
  tokenCount?: number;
  metadata?: unknown;
};

export type EmbeddedChunkInput = ChunkInput & {
  embedding: number[];
};

export type Neo4jConfig = {
  uri: string;
  user: string;
  password: string;
  database?: string;
};

export type GraphSyncJob = {
  jobId: string;
  namespace: string;
  operation: "upsert_memory" | "delete_memory" | "promote_memory";
  attempts: number;
  payload: unknown;
};

export type GraphMemoryScore = {
  memoryId: string;
  graphScore: number;
};

export type GraphExpandInput = {
  namespace: string;
  seedMemoryIds: string[];
  entityHints?: string[];
  hops?: number;
  limit?: number;
};

export type GraphStore = {
  syncJob: (job: GraphSyncJob) => Promise<void>;
  expand: (input: GraphExpandInput) => Promise<GraphMemoryScore[]>;
};

export type MemoryCard = {
  memoryId: string;
  namespace: string;
  key?: string;
  agentId?: string;
  text: string;
  score: number;
  semanticScore?: number;
  graphScore?: number;
  importance: number;
  source?: MemorySource;
  metadata?: unknown;
  entities: Array<{
    externalId: string;
    name: string;
    type: string;
    description?: string;
    confidence: number;
  }>;
  relationships: Array<{
    fromEntityExternalId: string;
    toEntityExternalId: string;
    type: string;
    description?: string;
    confidence: number;
    weight: number;
  }>;
};

export type AgentKnowledgeComponent = {
  actions: {
    recall: unknown;
  };
  mutations: {
    remember: unknown;
    observe: unknown;
    promote: unknown;
    deleteByKey: unknown;
    markGraphSyncJobRunning: unknown;
    markGraphSyncJobSucceeded: unknown;
    markGraphSyncJobFailed: unknown;
  };
  queries: {
    getMemory: unknown;
    listMemories: unknown;
    fetchMemoryCards: unknown;
    listPendingGraphSyncJobs: unknown;
  };
};

export type ConvexActionCtx = {
  runAction: (functionReference: unknown, args: Record<string, unknown>) => Promise<any>;
  runMutation: (functionReference: unknown, args: Record<string, unknown>) => Promise<any>;
  runQuery: (functionReference: unknown, args: Record<string, unknown>) => Promise<any>;
};

export type ConvexMutationCtx = {
  runMutation: (functionReference: unknown, args: Record<string, unknown>) => Promise<any>;
};

export type ConvexQueryCtx = {
  runQuery: (functionReference: unknown, args: Record<string, unknown>) => Promise<any>;
};
