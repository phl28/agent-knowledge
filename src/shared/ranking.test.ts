import { describe, expect, it } from "vitest";
import {
  applyRecencyDecay,
  clamp,
  DEFAULT_HALF_LIFE_DAYS,
  fuseMemoryScores,
  recencyWeight,
} from "./ranking.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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
    expect(results[0]!.memoryId).toBe("a");
    expect(results.find((result) => result.memoryId === "a")).toMatchObject({
      semanticScore: 0.8,
      graphScore: 2,
    });
  });

  it("ranks a newer memory above an older one at equal relevance", () => {
    const now = 1_000 * DAY_MS;
    const results = fuseMemoryScores(
      [
        {
          memoryId: "old",
          score: 0.8,
          semanticScore: 0.8,
          importance: 0.5,
          createdAt: now - 240 * DAY_MS,
        },
        {
          memoryId: "new",
          score: 0.8,
          semanticScore: 0.8,
          importance: 0.5,
          createdAt: now - 1 * DAY_MS,
        },
      ],
      [],
      { now },
    );

    expect(results.map((card) => card.memoryId)).toEqual(["new", "old"]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("does not bury a high-importance evergreen fact under decay", () => {
    const now = 1_000 * DAY_MS;
    const results = fuseMemoryScores(
      [
        {
          memoryId: "evergreen",
          score: 0.5,
          semanticScore: 0.5,
          importance: 1,
          createdAt: now - 720 * DAY_MS,
        },
        {
          memoryId: "recent-noise",
          score: 0.5,
          semanticScore: 0.5,
          importance: 0,
          createdAt: now,
        },
      ],
      [],
      { now, semanticWeight: 0.65, graphWeight: 0.25, importanceWeight: 0.4 },
    );

    expect(results[0]!.memoryId).toBe("evergreen");
  });

  it("applies no decay when now is not provided (backwards compatible)", () => {
    const results = fuseMemoryScores(
      [{ memoryId: "a", score: 0.8, semanticScore: 0.8, importance: 0, createdAt: 0 }],
      [],
    );
    expect(results[0]!.score).toBeCloseTo(0.8 * 0.65, 10);
  });
});

describe("recencyWeight", () => {
  it("halves relevance every half-life", () => {
    expect(recencyWeight(0)).toBe(1);
    expect(recencyWeight(DEFAULT_HALF_LIFE_DAYS * DAY_MS)).toBeCloseTo(0.5, 10);
    expect(recencyWeight(2 * DEFAULT_HALF_LIFE_DAYS * DAY_MS)).toBeCloseTo(0.25, 10);
  });

  it("respects a custom half-life", () => {
    expect(recencyWeight(30 * DAY_MS, 30)).toBeCloseTo(0.5, 10);
    expect(recencyWeight(30 * DAY_MS, 60)).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it("treats future or invalid ages and non-positive half-lives as no decay", () => {
    expect(recencyWeight(-DAY_MS)).toBe(1);
    expect(recencyWeight(Number.NaN)).toBe(1);
    expect(recencyWeight(DAY_MS, 0)).toBe(1);
  });
});

describe("applyRecencyDecay", () => {
  it("re-sorts semantic-only results by decayed score", () => {
    const now = 1_000 * DAY_MS;
    const results = applyRecencyDecay(
      [
        { memoryId: "old", score: 0.9, createdAt: now - 360 * DAY_MS },
        { memoryId: "new", score: 0.8, createdAt: now - 1 * DAY_MS },
      ],
      { now, limit: 2 },
    );

    expect(results.map((card) => card.memoryId)).toEqual(["new", "old"]);
  });

  it("leaves scores untouched for cards without createdAt", () => {
    const results = applyRecencyDecay([{ memoryId: "a", score: 0.7 }], { now: 123 });
    expect(results[0]!.score).toBe(0.7);
  });
});
