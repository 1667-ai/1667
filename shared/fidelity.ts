export function fidelityReport(fidelity: readonly string[]): string {
  return fidelity.length === 0 ? "no fidelity limitations reported" : fidelity.join("; ");
}

export function countNoun(count: number, singular: string, plural?: string): string {
  if (count === 1) return singular;
  return plural ?? `${singular}s`;
}
