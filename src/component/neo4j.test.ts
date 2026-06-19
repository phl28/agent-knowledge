import { describe, expect, it } from "vitest";
import { backoffMs, queryApiUrl, recordsOf } from "./neo4j.js";

describe("queryApiUrl", () => {
  it("derives the HTTPS Query API endpoint from an Aura neo4j+s:// URI", () => {
    expect(queryApiUrl("neo4j+s://abc123.databases.neo4j.io", "neo4j")).toBe(
      "https://abc123.databases.neo4j.io/db/neo4j/query/v2",
    );
  });

  it("uses the configured database name", () => {
    expect(queryApiUrl("neo4j+s://abc123.databases.neo4j.io", "graph")).toBe(
      "https://abc123.databases.neo4j.io/db/graph/query/v2",
    );
  });

  it("drops the bolt port (the HTTP API is not on it)", () => {
    expect(queryApiUrl("bolt://localhost:7687", "neo4j")).toBe(
      "https://localhost/db/neo4j/query/v2",
    );
  });

  it("strips embedded credentials from the authority", () => {
    expect(queryApiUrl("neo4j+s://user:pass@abc123.databases.neo4j.io", "neo4j")).toBe(
      "https://abc123.databases.neo4j.io/db/neo4j/query/v2",
    );
  });

  it("uses an http(s):// URI verbatim, preserving host and port", () => {
    expect(queryApiUrl("https://self-hosted:7473", "neo4j")).toBe(
      "https://self-hosted:7473/db/neo4j/query/v2",
    );
  });

  it("normalizes a trailing slash", () => {
    expect(queryApiUrl("https://self-hosted:7473/", "neo4j")).toBe(
      "https://self-hosted:7473/db/neo4j/query/v2",
    );
  });
});

describe("backoffMs", () => {
  it("grows exponentially from the initial delay", () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const base = 1000 * 2 ** (attempt - 1);
      const value = backoffMs(attempt);
      // base + up to 20% jitter, never below base.
      expect(value).toBeGreaterThanOrEqual(base);
      expect(value).toBeLessThanOrEqual(Math.round(base * 1.2));
    }
  });

  it("caps the delay (plus jitter) at the maximum backoff", () => {
    const maxBackoff = 5 * 60 * 1000;
    expect(backoffMs(100)).toBeLessThanOrEqual(Math.round(maxBackoff * 1.2));
    expect(backoffMs(100)).toBeGreaterThanOrEqual(maxBackoff);
  });
});

describe("recordsOf", () => {
  it("zips fields and values into records", () => {
    const body = {
      data: {
        fields: ["memoryId", "graphScore"],
        values: [
          ["a", 3],
          ["b", 1],
        ],
      },
    };
    expect(recordsOf(body)).toEqual([
      { memoryId: "a", graphScore: 3 },
      { memoryId: "b", graphScore: 1 },
    ]);
  });

  it("returns an empty array for null, empty, or missing data", () => {
    expect(recordsOf(null)).toEqual([]);
    expect(recordsOf({})).toEqual([]);
    expect(recordsOf({ data: { fields: [], values: [] } })).toEqual([]);
  });
});
