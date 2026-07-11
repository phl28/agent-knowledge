import { describe, expect, it } from "vitest";
import { jaccardSimilarity, mmrRerank } from "./mmr.js";

const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);

describe("jaccardSimilarity", () => {
  it("measures token overlap", () => {
    expect(jaccardSimilarity(tokens("aapl is a buy"), tokens("aapl is a buy"))).toBe(1);
    expect(jaccardSimilarity(tokens("aapl buy"), tokens("tsla sell"))).toBe(0);
    expect(jaccardSimilarity(tokens("aapl is a buy"), tokens("aapl is a sell"))).toBe(0.6);
  });

  it("treats untokenizable (empty-set) texts as diverse, not duplicates", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
    expect(jaccardSimilarity(tokens("aapl"), new Set())).toBe(0);
  });
});

describe("mmrRerank", () => {
  it("keeps the top result and demotes a duplicate in favor of a diverse one", () => {
    const results = mmrRerank(
      [
        { memoryId: "a", text: "user thinks AAPL is a strong buy this quarter", score: 0.9 },
        { memoryId: "a2", text: "user thinks AAPL is a strong buy this quarter", score: 0.6 },
        { memoryId: "b", text: "user prefers low-risk bond ETFs for retirement", score: 0.5 },
      ],
      { limit: 2 },
    );

    expect(results.map((result) => result.memoryId)).toEqual(["a", "b"]);
  });

  it("reduces to relevance ordering at lambda 1", () => {
    const candidates = [
      { memoryId: "low", text: "same text", score: 0.1 },
      { memoryId: "high", text: "same text", score: 0.9 },
      { memoryId: "mid", text: "same text", score: 0.5 },
    ];
    const results = mmrRerank(candidates, { lambda: 1, limit: 3 });
    expect(results.map((result) => result.memoryId)).toEqual(["high", "mid", "low"]);
  });

  it("returns input unchanged for zero or one candidate", () => {
    expect(mmrRerank([], { limit: 5 })).toEqual([]);
    const single = [{ memoryId: "a", text: "x", score: 1 }];
    expect(mmrRerank(single, { limit: 5 })).toEqual(single);
  });

  it("diversifies non-Latin text the same way (CJK bigram tokens)", () => {
    const results = mmrRerank(
      [
        { memoryId: "a", text: "用户认为苹果股票本季度值得强力买入", score: 0.9 },
        { memoryId: "a2", text: "用户认为苹果股票本季度值得强力买入", score: 0.6 },
        { memoryId: "b", text: "用户偏好低风险债券基金用于退休储蓄", score: 0.5 },
      ],
      { limit: 2 },
    );

    expect(results.map((result) => result.memoryId)).toEqual(["a", "b"]);
  });

  it("does not collapse distinct Cyrillic memories into duplicates", () => {
    const results = mmrRerank(
      [
        { memoryId: "a", text: "пользователь хочет купить акции", score: 0.9 },
        { memoryId: "a2", text: "пользователь хочет купить акции", score: 0.6 },
        { memoryId: "b", text: "низкий риск облигации на пенсию", score: 0.5 },
      ],
      { limit: 2 },
    );

    expect(results.map((result) => result.memoryId)).toEqual(["a", "b"]);
  });

  it("respects the limit", () => {
    const results = mmrRerank(
      [
        { memoryId: "a", text: "alpha beta", score: 0.9 },
        { memoryId: "b", text: "gamma delta", score: 0.8 },
        { memoryId: "c", text: "epsilon zeta", score: 0.7 },
      ],
      { limit: 2 },
    );
    expect(results).toHaveLength(2);
  });

  it("orders identical-text duplicates by raw score", () => {
    const results = mmrRerank(
      [
        { memoryId: "seed", text: "alpha beta", score: 0.9 },
        { memoryId: "dup-high", text: "alpha beta", score: 0.8 },
        { memoryId: "dup-low", text: "alpha beta", score: 0.7 },
      ],
      { lambda: 0.5, limit: 3 },
    );
    expect(results.map((result) => result.memoryId)).toEqual(["seed", "dup-high", "dup-low"]);
  });
});
