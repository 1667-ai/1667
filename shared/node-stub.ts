import { sliceWellFormedUtf16Prefix } from "./unicode.js";

const PREVIEW_CODE_UNITS = 100;

/** Canonical wire-format projection for a node whose full text may be cold. */
export function nodeStubPreviewText(text: string): string {
  return sliceWellFormedUtf16Prefix(text, PREVIEW_CODE_UNITS).normalize("NFC");
}

export function nodeStubHasInstruction(instruction: string): boolean {
  return instruction.trim().length > 0;
}
