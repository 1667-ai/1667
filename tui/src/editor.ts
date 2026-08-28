/** Inline edit contract: stripped guidance, an optional marked direction
 *  block, then prose. Without the marker, every line is prose, including
 *  `---` scene breaks. */
const GUIDANCE = [
  "≻ 1667 · prose needs no direction or separator.",
  "≻ Keep the direction marker only when you want model direction."
];
const DIRECTION_MARKER = "≻ direction";

export function serializePart(instruction: string, prose: string): string {
  const document = instruction.length > 0
    ? `${DIRECTION_MARKER}\n${instruction}\n---\n${prose}`
    : prose;
  return `${GUIDANCE.join("\n")}\n${document}`;
}

export function stripGuidance(value: string): string {
  return value.split("\n").filter((line) => !GUIDANCE.includes(line)).join("\n").replace(/^\n+/, "");
}

export function parsePartFile(value: string): { instruction: string; text: string } | null {
  const kept = stripGuidance(value);
  const marked = `${DIRECTION_MARKER}\n`;
  if (!kept.startsWith(marked)) return { instruction: "", text: kept };
  const body = kept.slice(marked.length);
  const separator = /\n---(?:\n|$)/u.exec(body);
  if (separator === null) return null;
  return {
    instruction: body.slice(0, separator.index),
    text: body.slice(separator.index + separator[0].length)
  };
}
