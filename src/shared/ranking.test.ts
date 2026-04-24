import { describe, expect, it } from "vitest";
import { clamp, fuseMemoryScores } from "./ranking.js";

describe("clamp", () => {
  it("limits values to the target range", () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(0.5)).toBe(0.5);
    expect(clamp(2)).toBe(1);
  });
});

describe("fuseMemoryScores", () => {
  it("merges semantic and graph scores by memory id", () => {
    const results = fuseMemoryScores(
      [{ memoryId: "a", score: 0.8, semanticScore: 0.8, importance: 0.2 }],
      [
        { memoryId: "a", score: 2, graphScore: 2, importance: 0.2 },
        { memoryId: "b", score: 3, graphScore: 3, importance: 0.1 },
      ],
      { limit: 2 },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.memoryId).toBe("b");
    expect(results.find((result) => result.memoryId === "a")).toMatchObject({
      semanticScore: 0.8,
      graphScore: 2,
    });
  });
});
