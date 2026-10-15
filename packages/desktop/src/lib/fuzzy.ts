export type FuzzyHit = { item: string; score: number; at: number[] };

/** Case-insensitive subsequence match. Consecutive and word-start hits score higher. */
export function fuzzy(item: string, query: string): FuzzyHit | null {
  const q = query.trim().toLowerCase();
  if (!q) return { item, score: 0, at: [] };
  const s = item.toLowerCase();
  const at: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    const i = s.indexOf(ch, from);
    if (i < 0) return null;
    const prev = at[at.length - 1];
    if (prev !== undefined && i === prev + 1) score += 5;
    if (i === 0 || /[^a-z0-9]/.test(s[i - 1]!)) score += 3;
    score -= i - from;
    at.push(i);
    from = i + 1;
  }
  return { item, score, at };
}

export function fuzzyFilter(items: string[], query: string): FuzzyHit[] {
  const hits = items.flatMap((it) => fuzzy(it, query) ?? []);
  return query.trim() ? hits.sort((a, b) => b.score - a.score) : hits;
}
