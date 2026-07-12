/** Deterministic identifiers for recommendation outcomes (ADR-023). */

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Produce a stable, human-debuggable identifier without relying on Web Crypto.
 * The date remains visible while source and normalized text distinguish actions
 * surfaced by different recommendation systems on that day.
 */
export function stableRecommendationId(date: string, source: string, text: string): string {
  const input = `${normalize(date)}\u0000${normalize(source)}\u0000${normalize(text)}`;
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `rec-${normalize(date)}-${(hash >>> 0).toString(36)}`;
}
