export type RankedMemoryCard = {
  memoryId: string;
  score: number;
  semanticScore?: number;
  graphScore?: number;
  importance?: number;
  createdAt?: number;
};

// Default chosen for durable agent knowledge (e.g. user preferences), which
// ages slower than chat-transcript memory — tune per deployment if needed.
export const DEFAULT_HALF_LIFE_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function recencyWeight(ageMs: number, halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  if (!Number.isFinite(ageMs) || ageMs <= 0 || halfLifeDays <= 0) {
    return 1;
  }
  return Math.exp((-Math.LN2 * ageMs) / (halfLifeDays * MS_PER_DAY));
}

function cardRecency(
  card: RankedMemoryCard,
  options?: { now?: number; halfLifeDays?: number },
): number {
  if (options?.now === undefined || card.createdAt === undefined) {
    return 1;
  }
  return recencyWeight(options.now - card.createdAt, options.halfLifeDays);
}

// Decay + sort step for result sets that skip score fusion (e.g. semantic-only
// recall, which is also the vector fallback path when the graph is down).
export function applyRecencyDecay<T extends RankedMemoryCard>(
  cards: T[],
  options?: { now?: number; halfLifeDays?: number; limit?: number },
) {
  return cards
    .map((card) => ({
      ...card,
      score: card.score * cardRecency(card, options),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options?.limit ?? cards.length);
}

export function fuseMemoryScores<T extends RankedMemoryCard>(
  semanticCards: T[],
  graphCards: T[],
  options?: {
    semanticWeight?: number;
    graphWeight?: number;
    importanceWeight?: number;
    limit?: number;
    now?: number;
    halfLifeDays?: number;
  },
) {
  const semanticWeight = options?.semanticWeight ?? 0.65;
  const graphWeight = options?.graphWeight ?? 0.25;
  const importanceWeight = options?.importanceWeight ?? 0.1;
  const byMemoryId = new Map<string, T>();

  for (const card of semanticCards) {
    byMemoryId.set(card.memoryId, {
      ...card,
      semanticScore: card.semanticScore ?? card.score,
    });
  }

  for (const graphCard of graphCards) {
    const current = byMemoryId.get(graphCard.memoryId);
    if (current) {
      byMemoryId.set(graphCard.memoryId, {
        ...current,
        graphScore: graphCard.graphScore ?? graphCard.score,
      });
    } else {
      byMemoryId.set(graphCard.memoryId, {
        ...graphCard,
        graphScore: graphCard.graphScore ?? graphCard.score,
        semanticScore: graphCard.semanticScore ?? 0,
      });
    }
  }

  return [...byMemoryId.values()]
    .map((card) => {
      const semanticScore = card.semanticScore ?? 0;
      const graphScore = card.graphScore ?? 0;
      const importance = card.importance ?? 0;
      // Decay only the relevance signals; importance stays sticky so durable
      // promoted facts are not buried by age alone.
      const recency = cardRecency(card, options);
      return {
        ...card,
        score:
          (semanticScore * semanticWeight + graphScore * graphWeight) * recency +
          importance * importanceWeight,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, options?.limit ?? 10);
}
