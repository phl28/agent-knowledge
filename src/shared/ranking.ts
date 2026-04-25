export type RankedMemoryCard = {
  memoryId: string;
  score: number;
  semanticScore?: number;
  graphScore?: number;
  importance?: number;
};

export function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function fuseMemoryScores<T extends RankedMemoryCard>(
  semanticCards: T[],
  graphCards: T[],
  options?: {
    semanticWeight?: number;
    graphWeight?: number;
    importanceWeight?: number;
    limit?: number;
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
      return {
        ...card,
        score:
          semanticScore * semanticWeight + graphScore * graphWeight + importance * importanceWeight,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, options?.limit ?? 10);
}
