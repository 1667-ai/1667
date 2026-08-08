export interface LegacyStoryLines {
  readonly lines: readonly string[];
  readonly normalizedLength: number;
  /** Map each source offset after a line separator to the number of
   * non-empty imported lines that end at or before that offset. */
  readonly partCountAtBoundary: ReadonlyMap<number, number>;
}

/** Normalize the complete legacy prose before you split it. This preserves
 * NFC composition when a Unicode sequence crosses a fragment boundary. */
export function splitLegacyStoryLines(source: string): LegacyStoryLines {
  const prose = source.normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const normalizedLines = prose.split("\n");
  const sourceBoundaries = lineBoundaryEnds(source);
  if (sourceBoundaries.length !== normalizedLines.length - 1) {
    throw new Error("Legacy line boundary mismatch");
  }

  const lines: string[] = [];
  const partCountAtBoundary = new Map<number, number>();
  normalizedLines.forEach((line, index) => {
    if (line.trim().length > 0) lines.push(line);
    const sourceBoundary = sourceBoundaries[index];
    if (sourceBoundary !== undefined) partCountAtBoundary.set(sourceBoundary, lines.length);
  });
  return { lines, normalizedLength: prose.length, partCountAtBoundary };
}

function lineBoundaryEnds(source: string): number[] {
  const ends: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      ends.push(index + 1);
    } else if (source[index] === "\r") {
      if (source[index + 1] === "\n") index += 1;
      ends.push(index + 1);
    }
  }
  return ends;
}
