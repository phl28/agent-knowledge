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
    syncGraph: unknown;
  };
  mutations: {
    remember: unknown;
    observe: unknown;
    promote: unknown;
    deleteByKey: unknown;
  };
  queries: {
    getMemory: unknown;
    listMemories: unknown;
  };
};

export type ConvexActionCtx = {
  runAction: (functionReference: unknown, args: Record<string, unknown>) => Promise<any>;
  runMutation: (
    functionReference: unknown,
    args: Record<string, unknown>,
  ) => Promise<any>;
  runQuery: (functionReference: unknown, args: Record<string, unknown>) => Promise<any>;
};

export type ConvexMutationCtx = {
  runMutation: (
    functionReference: unknown,
    args: Record<string, unknown>,
  ) => Promise<any>;
};

export type ConvexQueryCtx = {
  runQuery: (functionReference: unknown, args: Record<string, unknown>) => Promise<any>;
};
