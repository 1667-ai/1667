import { sliceWellFormedUtf16Prefix } from "./unicode.js";

const PREVIEW_CODE_UNITS = 100;
const LINE_BREAK = /[\r\n\u2028\u2029]/u;

/** Canonical wire-format projection for a node whose full text may be cold.
 *  A preview stops at the first line: the map draws it on one row, so text
 *  from the lines below would read as part of the same sentence.
 *
 *  The projection normalizes before it bounds, so projecting a preview again
 *  returns that same preview. A cold node re-projects its stored preview, and
 *  a projection that shrank its own output would shrink it once per save. */
export function nodeStubPreviewText(text: string): string {
  return sliceWellFormedUtf16Prefix(firstProseLine(text).normalize("NFC"), PREVIEW_CODE_UNITS);
}

export function nodeStubHasInstruction(instruction: string): boolean {
  return instruction.trim().length > 0;
}

/** The first line that holds prose. A node that opens with blank lines
 *  previews the text, not the blank lines. */
function firstProseLine(text: string): string {
  const start = text.search(/\S/u);
  if (start < 0) return "";
  const body = text.slice(start);
  const end = body.search(LINE_BREAK);
  return end < 0 ? body : body.slice(0, end);
}
