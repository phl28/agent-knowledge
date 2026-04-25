import { v } from "convex/values";

export const supportedEmbeddingDimensions = [
  128, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096,
] as const;

export type SupportedEmbeddingDimension = (typeof supportedEmbeddingDimensions)[number];

export const sourceValidator = v.object({
  type: v.string(),
  id: v.optional(v.string()),
  url: v.optional(v.string()),
  title: v.optional(v.string()),
});

export const entityInputValidator = v.object({
  externalId: v.string(),
  name: v.string(),
  type: v.string(),
  description: v.optional(v.string()),
  aliases: v.optional(v.array(v.string())),
  confidence: v.optional(v.number()),
  metadata: v.optional(v.any()),
});

export const relationshipInputValidator = v.object({
  fromEntityExternalId: v.string(),
  toEntityExternalId: v.string(),
  type: v.string(),
  description: v.optional(v.string()),
  confidence: v.optional(v.number()),
  weight: v.optional(v.number()),
  metadata: v.optional(v.any()),
});

export const chunkInputValidator = v.object({
  text: v.string(),
  embedding: v.array(v.float64()),
  summary: v.optional(v.string()),
  tokenCount: v.optional(v.number()),
  metadata: v.optional(v.any()),
});

export const memoryCardValidator = v.object({
  memoryId: v.string(),
  namespace: v.string(),
  key: v.optional(v.string()),
  agentId: v.optional(v.string()),
  text: v.string(),
  score: v.number(),
  semanticScore: v.optional(v.number()),
  graphScore: v.optional(v.number()),
  importance: v.number(),
  source: v.optional(sourceValidator),
  metadata: v.optional(v.any()),
  entities: v.array(
    v.object({
      externalId: v.string(),
      name: v.string(),
      type: v.string(),
      description: v.optional(v.string()),
      confidence: v.number(),
    }),
  ),
  relationships: v.array(
    v.object({
      fromEntityExternalId: v.string(),
      toEntityExternalId: v.string(),
      type: v.string(),
      description: v.optional(v.string()),
      confidence: v.number(),
      weight: v.number(),
    }),
  ),
});

export function vectorTableForDimension(dimension: number) {
  switch (dimension) {
    case 128:
      return "vectors_128";
    case 256:
      return "vectors_256";
    case 384:
      return "vectors_384";
    case 512:
      return "vectors_512";
    case 768:
      return "vectors_768";
    case 1024:
      return "vectors_1024";
    case 1536:
      return "vectors_1536";
    case 2048:
      return "vectors_2048";
    case 3072:
      return "vectors_3072";
    case 4096:
      return "vectors_4096";
    default:
      throw new Error(
        `Unsupported embedding dimension ${dimension}. Supported dimensions: ${supportedEmbeddingDimensions.join(", ")}`,
      );
  }
}
