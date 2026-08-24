import { sliceWellFormedUtf16Prefix } from "./unicode.js";

const PREVIEW_CODE_UNITS = 100;
const LINE_BREAK = /[\r\n\u2028\u2029]/u;
const PREVIEW_GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

export interface BoundedNodeStubPreview {
  readonly text: string;
  /** False when more source text is required for an exact preview. */
  readonly complete: boolean;
}

/** Canonical wire-format projection for a node whose full text may be cold.
 *  A preview stops at the first line: the map draws it on one row, so text
 *  from the lines below would read as part of the same sentence.
 *
 *  The projection normalizes before it bounds, so projecting a preview again
 *  returns that same preview. A cold node re-projects its stored preview, and
 *  a projection that shrank its own output would shrink it once per save. */
export function nodeStubPreviewText(text: string): string {
  const start = text.search(/\S/u);
  if (start < 0) return "";
  const body = text.slice(start);
  const end = body.search(LINE_BREAK);
  const line = end < 0 ? body : body.slice(0, end);
  return normalizedPreview(line);
}

/** Calculate an exact preview only when it fits in a fixed source budget. */
export function boundedNodeStubPreviewText(
  text: string,
  maxSourceUnits: number
): BoundedNodeStubPreview {
  const source = sliceWellFormedUtf16Prefix(text, Math.max(0, Math.floor(maxSourceUnits)));
  const sourceComplete = source.length === text.length;
  const start = source.search(/\S/u);
  if (start < 0) return { text: "", complete: sourceComplete };

  let preview = "";
  const body = source.slice(start);
  for (const { index, segment } of PREVIEW_GRAPHEMES.segment(body)) {
    if (LINE_BREAK.test(segment)) {
      return { text: normalizedPreview(preview), complete: true };
    }
    preview += segment;
    if (preview.normalize("NFC").length >= PREVIEW_CODE_UNITS) {
      const segmentComplete = sourceComplete || index + segment.length < body.length;
      return { text: normalizedPreview(preview), complete: segmentComplete };
    }
  }
  return { text: normalizedPreview(preview), complete: sourceComplete };
}

export function nodeStubHasInstruction(instruction: string): boolean {
  return instruction.trim().length > 0;
}

function normalizedPreview(source: string): string {
  return sliceWellFormedUtf16Prefix(source.normalize("NFC"), PREVIEW_CODE_UNITS);
}
