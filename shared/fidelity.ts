export function fidelityReport(fidelity: readonly string[]): string {
  return fidelity.length === 0 ? "no fidelity limitations reported" : fidelity.join("; ");
}

export function countNoun(count: number, singular: string, plural?: string): string {
  if (count === 1) return singular;
  return plural ?? `${singular}s`;
}

export type LossPhrases<K extends string> = Readonly<Record<K, (count: number) => string>>;

/** Count each kind of loss as it occurs, and report only the kinds that fired,
 * in the phrase table's declaration order.
 *
 * A counter declared but never pushed used to compile cleanly and silently
 * drop a fidelity line. Counting occurrences instead of incrementing separate
 * counters removes that failure mode: every kind the table knows about either
 * reports or it does not occur. */
export function lossLines<K extends string>(
  occurrences: Iterable<K>,
  phrases: LossPhrases<K>
): string[] {
  const counts = new Map<K, number>();
  for (const kind of occurrences) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return (Object.keys(phrases) as K[])
    .filter((kind) => (counts.get(kind) ?? 0) > 0)
    .map((kind) => phrases[kind](counts.get(kind)!));
}
