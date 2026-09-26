import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { extractKnowledge, heuristicExtractKnowledge } from "./extraction.js";

function modelReplying(text: string) {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

const RULE_MEMORY =
  "Focus-list threshold rule: only put a name on the focus list if there is a plausible entry point that session. Otherwise park it on the Watchlist.";

describe("extractKnowledge", () => {
  it("fences the memory as data outside the instructions", async () => {
    const model = modelReplying('{"entities":[],"relationships":[]}');
    await extractKnowledge({ namespace: "user:a", text: RULE_MEMORY, model });

    const [call] = model.doGenerateCalls;
    const system = call?.prompt.find((message) => message.role === "system");
    const user = call?.prompt.find((message) => message.role === "user");
    expect(JSON.stringify(system)).not.toContain(RULE_MEMORY);
    expect(JSON.stringify(user)).toContain(`<memory>\\n${RULE_MEMORY}\\n</memory>`);
  });

  it("falls back to heuristic extraction when the model answers in prose", async () => {
    const model = modelReplying(
      "I notice you haven't provided the text or content you want me to analyze.",
    );
    const result = await extractKnowledge({ namespace: "user:a", text: RULE_MEMORY, model });

    expect(result).toEqual(heuristicExtractKnowledge("user:a", RULE_MEMORY));
  });
});

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
