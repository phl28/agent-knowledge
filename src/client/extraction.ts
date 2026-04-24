import { generateObject } from "ai";
import { z } from "zod";
import type { ExtractedKnowledge } from "./types.js";
import { normalizeEntityId } from "./hash.js";

const extractionSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      type: z.string().default("entity"),
      description: z.string().optional(),
      aliases: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  ),
  relationships: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      type: z.string(),
      description: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      weight: z.number().min(0).max(1).optional(),
    }),
  ),
});

export type ExtractKnowledgeOptions = {
  namespace: string;
  text: string;
  model?: unknown;
};

export async function extractKnowledge(
  options: ExtractKnowledgeOptions,
): Promise<ExtractedKnowledge> {
  if (options.model) {
    const result = await generateObject({
      model: options.model as never,
      schema: extractionSchema,
      prompt: [
        "Extract entities and relationships useful for long-lived agent memory.",
        "Use concise entity names. Relationship types should be uppercase snake case.",
        "Only include facts supported by the text.",
        "",
        options.text,
      ].join("\n"),
    });
    const byName = new Map<string, string>();
    const entities = result.object.entities.map((entity) => {
      const externalId = normalizeEntityId(
        options.namespace,
        entity.name,
        entity.type,
      );
      byName.set(entity.name.toLowerCase(), externalId);
      return {
        externalId,
        name: entity.name,
        type: entity.type,
        description: entity.description,
        aliases: entity.aliases,
        confidence: entity.confidence ?? 0.75,
      };
    });
    return {
      entities,
      relationships: result.object.relationships
        .map((relationship) => {
          const fromEntityExternalId = byName.get(relationship.from.toLowerCase());
          const toEntityExternalId = byName.get(relationship.to.toLowerCase());
          if (!fromEntityExternalId || !toEntityExternalId) {
            return null;
          }
          return {
            fromEntityExternalId,
            toEntityExternalId,
            type: relationship.type,
            description: relationship.description,
            confidence: relationship.confidence ?? 0.75,
            weight: relationship.weight ?? 0.5,
          };
        })
        .filter((relationship): relationship is NonNullable<typeof relationship> =>
          Boolean(relationship),
        ),
    };
  }

  return heuristicExtractKnowledge(options.namespace, options.text);
}

export function heuristicExtractKnowledge(
  namespace: string,
  text: string,
): ExtractedKnowledge {
  const candidates = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][a-zA-Z0-9_-]{2,}(?:\s+[A-Z][a-zA-Z0-9_-]{2,}){0,3}\b/g)) {
    candidates.add(match[0]);
  }
  const entities = [...candidates].slice(0, 24).map((name) => ({
    externalId: normalizeEntityId(namespace, name),
    name,
    type: "entity",
    confidence: 0.45,
  }));
  return {
    entities,
    relationships: [],
  };
}
