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
  createdAt: number;
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
    forgetNamespace: unknown;
  };
  queries: {
    getMemory: unknown;
    listMemories: unknown;
  };
};

// These accept Convex's GenericActionCtx/GenericMutationCtx/GenericQueryCtx
// structurally. The function-reference parameters are intentionally loose
// (`...args: any[]`): the client treats component function references opaquely,
// and a stricter `unknown` parameter would make the real Convex ctx types fail
// to assign here under strict function variance.
export type ConvexActionCtx = {
  runAction: (...args: any[]) => Promise<any>;
  runMutation: (...args: any[]) => Promise<any>;
  runQuery: (...args: any[]) => Promise<any>;
};

export type ConvexMutationCtx = {
  runMutation: (...args: any[]) => Promise<any>;
};

export type ConvexQueryCtx = {
  runQuery: (...args: any[]) => Promise<any>;
};
