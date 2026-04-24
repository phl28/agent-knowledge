import { describe, expect, it } from "vitest";
import { normalizeEntityId, stableHash } from "./hash.js";

describe("stableHash", () => {
  it("is deterministic", () => {
    expect(stableHash("agent memory")).toBe(stableHash("agent memory"));
    expect(stableHash("agent memory")).not.toBe(stableHash("other memory"));
  });
});

describe("normalizeEntityId", () => {
  it("builds namespace-scoped entity IDs", () => {
    expect(normalizeEntityId("agent:alice", "Convex Components", "tool")).toBe(
      "agent:alice:tool:convex-components",
    );
  });
});
