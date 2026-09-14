/** Shared v1 Aside values used by both legacy and v2 codecs. */
import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";

/** One saved question-and-answer pair. */
export interface SideNote {
  readonly question: string;
  readonly answer: string;
}

/** The complete bounded Aside document for one story. */
export interface AsideDocument {
  readonly schemaVersion: 1;
  readonly notes: readonly SideNote[];
}

export const ASIDE_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const MAX_SIDE_NOTES = 100;
export const MAX_ASIDE_QUESTION_SCALARS = 8_192;
export const MAX_ASIDE_ANSWER_SCALARS = 32_768;
export const MAX_ASIDE_DOCUMENT_BYTES = 1 * 1024 * 1024;
export const ASIDE_EXPORT_OMISSION_NOTICE = "Side Notes were not exported.";

export class AsideDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsideDocumentError";
  }
}

export function assertAsideQuestion(question: string): void {
  if (typeof question !== "string") {
    throw new AsideDocumentError("Aside question must be a string");
  }
  if (hasUnpairedSurrogate(question)) {
    throw new AsideDocumentError("Aside question contains an unpaired Unicode surrogate");
  }
  if (question.trim().length === 0) {
    throw new AsideDocumentError("Aside question must not be empty");
  }
  if (unicodeScalarLength(question, MAX_ASIDE_QUESTION_SCALARS + 1) > MAX_ASIDE_QUESTION_SCALARS) {
    throw new AsideDocumentError(
      `Aside question exceeds ${MAX_ASIDE_QUESTION_SCALARS.toLocaleString()} Unicode scalars`
    );
  }
}

export function assertAsideAnswer(answer: string): void {
  if (typeof answer !== "string") {
    throw new AsideDocumentError("Aside answer must be a string");
  }
  if (hasUnpairedSurrogate(answer)) {
    throw new AsideDocumentError("Aside answer contains an unpaired Unicode surrogate");
  }
  if (answer.length === 0) {
    throw new AsideDocumentError("Aside answer must not be empty");
  }
  if (unicodeScalarLength(answer, MAX_ASIDE_ANSWER_SCALARS + 1) > MAX_ASIDE_ANSWER_SCALARS) {
    throw new AsideDocumentError(
      `Aside answer exceeds ${MAX_ASIDE_ANSWER_SCALARS.toLocaleString()} Unicode scalars`
    );
  }
}

export function assertAsideDocument(document: AsideDocument): void {
  if (document.schemaVersion !== ASIDE_DOCUMENT_SCHEMA_VERSION) {
    throw new AsideDocumentError("Aside document schemaVersion is unsupported");
  }
  if (document.notes.length > MAX_SIDE_NOTES) {
    throw new AsideDocumentError(
      `Aside document exceeds the ${MAX_SIDE_NOTES}-Side-Note limit`
    );
  }
  for (const note of document.notes) {
    assertAsideQuestion(note.question);
    assertAsideAnswer(note.answer);
  }
}

/** Empty document. */
export function emptyAsideDocument(): AsideDocument {
  return { schemaVersion: ASIDE_DOCUMENT_SCHEMA_VERSION, notes: [] };
}

/** Append one pair and return a new document. Does not mutate the input. */
export function appendSideNote(
  document: AsideDocument | null,
  question: string,
  answer: string
): AsideDocument {
  assertAsideQuestion(question);
  assertAsideAnswer(answer);
  const notes = document?.notes ?? [];
  if (notes.length >= MAX_SIDE_NOTES) {
    throw new AsideDocumentError(
      `Aside document already holds ${MAX_SIDE_NOTES} Side Notes; clear it before adding more`
    );
  }
  const next: AsideDocument = {
    schemaVersion: ASIDE_DOCUMENT_SCHEMA_VERSION,
    notes: [...notes, { question, answer }]
  };
  const bytes = new TextEncoder().encode(serializeAsideDocument(next)).byteLength;
  if (bytes > MAX_ASIDE_DOCUMENT_BYTES) {
    throw new AsideDocumentError(
      `Aside document would exceed its ${MAX_ASIDE_DOCUMENT_BYTES}-byte size limit`
    );
  }
  return next;
}

/** Canonical JSON for content addressing. Key order is fixed. */
export function serializeAsideDocument(document: AsideDocument): string {
  assertAsideDocument(document);
  const notes = document.notes.map((note) => ({
    question: note.question,
    answer: note.answer
  }));
  return JSON.stringify({ schemaVersion: ASIDE_DOCUMENT_SCHEMA_VERSION, notes });
}
