import { describe, expect, it } from "vitest";
import { heuristicExtractKnowledge } from "./extraction.js";

describe("heuristicExtractKnowledge", () => {
  it("extracts capitalized entity candidates", () => {
    const result = heuristicExtractKnowledge(
      "agent:alice",
      "Alice is building Agent Knowledge with Convex and Neo4j.",
    );
    expect(result.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(["Alice", "Agent Knowledge", "Convex", "Neo4j"]),
    );
    expect(result.relationships).toEqual([]);
  });
});
