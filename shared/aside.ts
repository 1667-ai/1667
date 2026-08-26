import { createHash } from "node:crypto";
import {
  ASIDE_DOCUMENT_SCHEMA_VERSION,
  ASIDE_EXPORT_OMISSION_NOTICE,
  AsideDocumentError,
  assertAsideAnswer,
  assertAsideDocument,
  assertAsideQuestion,
  MAX_ASIDE_ANSWER_SCALARS,
  MAX_ASIDE_DOCUMENT_BYTES,
  MAX_SIDE_NOTES,
  type AsideDocument,
  type SideNote
} from "./aside-core.js";

export {
  ASIDE_DOCUMENT_SCHEMA_VERSION,
  ASIDE_EXPORT_OMISSION_NOTICE,
  AsideDocumentError,
  assertAsideAnswer,
  assertAsideDocument,
  assertAsideQuestion,
  MAX_ASIDE_ANSWER_SCALARS,
  MAX_ASIDE_DOCUMENT_BYTES,
  MAX_SIDE_NOTES
} from "./aside-core.js";
export type { AsideDocument, SideNote } from "./aside-core.js";

/** JSON framing around one notes[] element. Content is reserved separately. */
const PAIR_JSON_FRAMING_BYTES = Buffer.byteLength(
  '{"question":,"answer":},',
  "utf8"
);

/**
 * JSON.stringify escapes controls, quotes, and backslashes. A control scalar
 * therefore needs six ASCII bytes (`\\u0000`), which is larger than its UTF-8
 * representation. Reserve that maximum for persisted answer text.
 */
const MAX_JSON_STRING_BYTES_PER_SCALAR = 6;

/** Empty document. */
export function emptyAsideDocument(): AsideDocument {
  return { schemaVersion: ASIDE_DOCUMENT_SCHEMA_VERSION, notes: [] };
}

/**
 * Worst-case UTF-8 size reserved for one new Side Note pair before provider
 * work. The question uses its exact serialized JSON string size. The answer
 * reserves the maximum JSON string size for every allowed Unicode scalar.
 * This keeps the admission check conservative for quotes, controls, and
 * backslashes instead of allowing provider work that appendSideNote rejects.
 */
export function worstCasePairUtf8Bytes(question: string): number {
  const questionBytes = Buffer.byteLength(JSON.stringify(question), "utf8");
  const maxAnswerBytes = 2 + MAX_ASIDE_ANSWER_SCALARS * MAX_JSON_STRING_BYTES_PER_SCALAR;
  return questionBytes + maxAnswerBytes + PAIR_JSON_FRAMING_BYTES;
}

/**
 * True when the current document plus one worst-case new pair still fits
 * under the document byte ceiling and the note-count ceiling.
 */
export function canAdmitAsidePair(
  document: AsideDocument | null,
  question: string,
  currentDocumentUtf8Bytes: number
): { ok: true } | { ok: false; reason: "count" | "size" | "question" } {
  const notes = document?.notes ?? [];
  if (notes.length >= MAX_SIDE_NOTES) return { ok: false, reason: "count" };
  try {
    assertAsideQuestion(question);
  } catch {
    return { ok: false, reason: "question" };
  }
  const nextBytes = currentDocumentUtf8Bytes + worstCasePairUtf8Bytes(question);
  if (nextBytes > MAX_ASIDE_DOCUMENT_BYTES) return { ok: false, reason: "size" };
  return { ok: true };
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
  const bytes = Buffer.byteLength(serializeAsideDocument(next), "utf8");
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

export function parseAsideDocument(raw: string, expectedHash?: string): AsideDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new AsideDocumentError("Aside document is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AsideDocumentError("Aside document must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("schemaVersion") || !keys.includes("notes")) {
    throw new AsideDocumentError("Aside document has unknown or missing keys");
  }
  if (record.schemaVersion !== ASIDE_DOCUMENT_SCHEMA_VERSION) {
    throw new AsideDocumentError("Aside document schemaVersion is unsupported");
  }
  if (!Array.isArray(record.notes)) {
    throw new AsideDocumentError("Aside document notes must be an array");
  }
  if (record.notes.length > MAX_SIDE_NOTES) {
    throw new AsideDocumentError(
      `Aside document exceeds the ${MAX_SIDE_NOTES}-Side-Note limit`
    );
  }
  const notes: SideNote[] = [];
  for (const [index, entry] of record.notes.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AsideDocumentError(`Aside document notes[${index}] must be an object`);
    }
    const note = entry as Record<string, unknown>;
    const noteKeys = Object.keys(note);
    if (noteKeys.length !== 2 || !noteKeys.includes("question") || !noteKeys.includes("answer")) {
      throw new AsideDocumentError(`Aside document notes[${index}] has unknown or missing keys`);
    }
    if (typeof note.question !== "string" || typeof note.answer !== "string") {
      throw new AsideDocumentError(`Aside document notes[${index}] fields must be strings`);
    }
    assertAsideQuestion(note.question);
    assertAsideAnswer(note.answer);
    notes.push({ question: note.question, answer: note.answer });
  }
  const document: AsideDocument = { schemaVersion: ASIDE_DOCUMENT_SCHEMA_VERSION, notes };
  const serialized = serializeAsideDocument(document);
  if (Buffer.byteLength(serialized, "utf8") > MAX_ASIDE_DOCUMENT_BYTES) {
    throw new AsideDocumentError(
      `Aside document exceeds its ${MAX_ASIDE_DOCUMENT_BYTES}-byte size limit`
    );
  }
  if (expectedHash !== undefined) {
    // Match storeAsideDocument / putObject: SHA-256 of the exact stored bytes.
    const hash = createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex");
    if (hash !== expectedHash) {
      throw new AsideDocumentError(`Aside document hash mismatch for ${expectedHash}`);
    }
  }
  return document;
}

// Stable v2 re-exports. The implementation lives in aside-session.ts so the
// legacy v1 codec remains small and rollback-compatible.
export {
  appendAsideTurn,
  asideHistoryFromSession,
  asideTitleFromQuestion,
  assertAsideAnchor,
  assertAsideSessionDocument,
  assertAsideThoughts,
  assertAsideTitle,
  assertAsideTurn,
  canAdmitAsideTurn,
  deleteAsideTurn,
  emptyAsideSessionDocument,
  migrateAsideDocumentToUnanchored,
  parseAsideSessionDocument,
  hashAsideSessionDocument,
  replaceAsideTurn,
  resetAsideSession,
  retakeAsideSession,
  serializeAsideSessionDocument,
  truncateAsideThoughtsToFit,
  worstCaseAsideTurnUtf8Bytes,
  ASIDE_SESSION_SCHEMA_VERSION,
  MAX_ASIDE_THOUGHT_SCALARS,
  MAX_ASIDE_TITLE_SCALARS,
  MAX_ASIDE_TURNS
} from "./aside-session.js";
export { asidePresenceFromIndex } from "./aside-session-index.js";
export type {
  AsideAnchor,
  AsideDocumentV2,
  AsideSessionDocument,
  AsideTurn
} from "./aside-session.js";
export type {
  AsidePresenceSummary,
  AsideSessionIndex,
  AsideSessionRef
} from "./aside-session-index.js";
