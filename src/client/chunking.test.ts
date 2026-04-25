import { describe, expect, it } from "vitest";
import { chunkText } from "./chunking.js";

describe("chunkText", () => {
  it("returns no chunks for empty input", () => {
    expect(chunkText("   ")).toEqual([]);
  });

  it("keeps short text as one chunk", () => {
    expect(chunkText("Alice works on Convex components.")).toEqual([
      {
        text: "Alice works on Convex components.",
        tokenCount: 9,
      },
    ]);
  });

  it("splits long text with overlap", () => {
    const text = Array.from({ length: 60 }, (_, index) => `Sentence ${index}.`).join(" ");
    const chunks = chunkText(text, { maxChars: 220, overlapChars: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.text.length).toBeLessThanOrEqual(220);
    expect(chunks.at(-1)!.text).toContain("Sentence 59");
  });
});
