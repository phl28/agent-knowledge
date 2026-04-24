import type { ChunkInput } from "./types.js";

export type ChunkTextOptions = {
  maxChars?: number;
  overlapChars?: number;
};

export function chunkText(text: string, options?: ChunkTextOptions): ChunkInput[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const maxChars = Math.max(options?.maxChars ?? 1_500, 200);
  const overlapChars = Math.min(options?.overlapChars ?? 150, Math.floor(maxChars / 3));
  const chunks: ChunkInput[] = [];
  let cursor = 0;

  while (cursor < trimmed.length) {
    const hardEnd = Math.min(cursor + maxChars, trimmed.length);
    let end = hardEnd;
    if (hardEnd < trimmed.length) {
      const paragraphBreak = trimmed.lastIndexOf("\n\n", hardEnd);
      const sentenceBreak = trimmed.lastIndexOf(". ", hardEnd);
      const whitespaceBreak = trimmed.lastIndexOf(" ", hardEnd);
      const bestBreak = Math.max(paragraphBreak, sentenceBreak, whitespaceBreak);
      if (bestBreak > cursor + Math.floor(maxChars * 0.55)) {
        end = bestBreak + (bestBreak === sentenceBreak ? 1 : 0);
      }
    }

    const chunk = trimmed.slice(cursor, end).trim();
    if (chunk) {
      chunks.push({
        text: chunk,
        tokenCount: Math.ceil(chunk.length / 4),
      });
    }
    if (end >= trimmed.length) {
      break;
    }
    cursor = Math.max(end - overlapChars, cursor + 1);
  }

  return chunks;
}
