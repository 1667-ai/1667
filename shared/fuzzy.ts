export interface FuzzyMatch {
  indices: number[];
  score: number;
}

/** Ordered, case-insensitive fuzzy match. Contiguous and early matches rank first. */
export function fuzzyMatch(value: string, query: string): FuzzyMatch | null {
  const needle = [...query.trim().toLocaleLowerCase()];
  if (needle.length === 0) return { indices: [], score: 0 };
  const haystack = [...value.toLocaleLowerCase()];
  const indices: number[] = [];
  let cursor = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;
    indices.push(found);
    cursor = found + 1;
  }
  const gaps = indices.reduce((sum, index, offset) => offset === 0 ? sum : sum + index - indices[offset - 1]! - 1, 0);
  return { indices, score: (indices[0] ?? 0) * 3 + gaps * 2 + value.length / 100 };
}

export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  if (query.trim().length === 0) return [...items];
  return items.map((item) => ({ item, match: fuzzyMatch(text(item), query) }))
    .filter((entry): entry is { item: T; match: FuzzyMatch } => entry.match !== null)
    .sort((left, right) => left.match.score - right.match.score)
    .map(({ item }) => item);
}
