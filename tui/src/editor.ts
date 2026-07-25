/** Inline edit contract: stripped `≻` guidance lines, instruction, first
 *  `---` line, prose. Prose may contain `---` lines; only the first one after
 *  the instruction delimits. */
const GUIDANCE = [
  "≻ 1667 · your direction above the first --- line, the story text below.",
  "≻ Later --- lines belong to the prose. Delete these ≻ lines freely."
];

export function serializePart(instruction: string, prose: string): string {
  return `${GUIDANCE.join("\n")}\n${instruction}\n---\n${prose}`;
}

export function stripGuidance(value: string): string {
  return value.split("\n").filter((line) => !line.startsWith("≻")).join("\n").replace(/^\n+/, "");
}

export function parsePartFile(value: string): { instruction: string; text: string } | null {
  const kept = stripGuidance(value);
  if (kept.startsWith("---\n")) return { instruction: "", text: kept.slice(4) };
  const delimiter = kept.indexOf("\n---\n");
  if (delimiter === -1) return null;
  return { instruction: kept.slice(0, delimiter), text: kept.slice(delimiter + 5) };
}
