export type MmrCandidate = {
  memoryId: string;
  text: string;
  score: number;
};

export const DEFAULT_MMR_LAMBDA = 0.7;

// Lexical (token-set Jaccard) similarity rather than embedding cosine: memory
// cards do not carry embeddings at ranking time, and re-embedding inside the
// component would add a model call per recall.
function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

// Maximal Marginal Relevance (Carbonell & Goldstein, 1998): greedily pick the
// candidate maximizing `lambda * relevance - (1 - lambda) * maxSimToSelected`.
// Relevance is min-max normalized across the candidate set so it is comparable
// to the [0, 1] Jaccard similarity term.
export function mmrRerank<T extends MmrCandidate>(
  candidates: T[],
  options?: { lambda?: number; limit?: number },
): T[] {
  const limit = Math.min(options?.limit ?? candidates.length, candidates.length);
  const lambda = Math.min(1, Math.max(0, options?.lambda ?? DEFAULT_MMR_LAMBDA));
  if (candidates.length <= 1 || limit <= 0) {
    return candidates.slice(0, limit);
  }
  if (lambda === 1) {
    return [...candidates].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  const scores = candidates.map((candidate) => candidate.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore;
  const relevance = scores.map((score) => (range === 0 ? 1 : (score - minScore) / range));
  const tokens = candidates.map((candidate) => tokenize(candidate.text));

  const selected: T[] = [];
  const remaining = candidates.map((_, index) => index);
  const maxSimToSelected = candidates.map(() => 0);

  while (selected.length < limit && remaining.length > 0) {
    let bestPosition = 0;
    let bestMmr = -Infinity;
    for (let position = 0; position < remaining.length; position += 1) {
      const index = remaining[position]!;
      const mmr =
        selected.length === 0
          ? relevance[index]!
          : lambda * relevance[index]! - (1 - lambda) * maxSimToSelected[index]!;
      const currentBest = remaining[bestPosition]!;
      if (mmr > bestMmr || (mmr === bestMmr && scores[index]! > scores[currentBest]!)) {
        bestMmr = mmr;
        bestPosition = position;
      }
    }
    const chosen = remaining.splice(bestPosition, 1)[0]!;
    selected.push(candidates[chosen]!);
    for (const index of remaining) {
      const similarity = jaccardSimilarity(tokens[index]!, tokens[chosen]!);
      if (similarity > maxSimToSelected[index]!) {
        maxSimToSelected[index] = similarity;
      }
    }
  }
  return selected;
}
