/**
 * Story Aside v2 session documents.
 *
 * A session is one bounded, linear chat anchored to a story part and take.
 * Session text stays in its content-addressed object. Presence summaries use
 * only session identifiers, anchors, and turn counts.
 */
import { createHash } from "node:crypto";
import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";
import {
  assertAsideAnswer,
  assertAsideDocument,
  assertAsideQuestion,
  AsideDocumentError,
  MAX_ASIDE_ANSWER_SCALARS,
  MAX_ASIDE_DOCUMENT_BYTES,
  MAX_SIDE_NOTES,
  type AsideDocument,
  type SideNote
} from "./aside-core.js";

/** The immutable story position that owns one Aside session. */
export interface AsideAnchor {
  readonly partId: string;
  readonly takeId: string;
}

/** One linear Aside exchange in a v2 session. */
export interface AsideTurn {
  readonly q: string;
  readonly a: string;
  /** Render-only reasoning text. It never enters an Aside prompt. */
  readonly thoughts?: string;
  /** Provider-reported cumulative reasoning token count. */
  readonly thoughtTokens?: number;
}

/**
 * One bounded, take-anchored Aside chat session.
 *
 * `anchor: null` is the durable representation of the story-level
 * unanchored bucket. Anchored sessions always carry both identifiers.
 */
export interface AsideSessionDocument {
  readonly schemaVersion: 2;
  readonly anchor: AsideAnchor | null;
  readonly title: string;
  readonly turns: readonly AsideTurn[];
}

/** Descriptive alias used by storage and transport callers. */
export type AsideDocumentV2 = AsideSessionDocument;

export const ASIDE_SESSION_SCHEMA_VERSION = 2 as const;

/** Maximum turns in one v2 session. Kept equal to the v1 note ceiling. */
export const MAX_ASIDE_TURNS = MAX_SIDE_NOTES;

/** Maximum Unicode scalars in a session title. */
export const MAX_ASIDE_TITLE_SCALARS = 256;

/** Maximum Unicode scalars in retained session reasoning. */
export const MAX_ASIDE_THOUGHT_SCALARS = MAX_ASIDE_ANSWER_SCALARS;

/** JSON.stringify's maximum bytes for one Unicode scalar in a string. */
const MAX_JSON_STRING_BYTES_PER_SCALAR = 6;

/** Worst-case persisted bytes for one v2 turn before optional thoughts. */
export function worstCaseAsideTurnUtf8Bytes(question: string): number {
  const questionBytes = Buffer.byteLength(JSON.stringify(question), "utf8");
  const maxAnswerBytes = 2 + MAX_ASIDE_ANSWER_SCALARS * MAX_JSON_STRING_BYTES_PER_SCALAR;
  // q/a keys and commas are reserved separately from string values. Reasoning
  // is optional and is fitted after the provider answer is available.
  return questionBytes + maxAnswerBytes
    + Buffer.byteLength('{"q":,"a":},', "utf8");
}

/**
 * Admit a v2 turn before provider work. The check is conservative for JSON
 * escaping and therefore cannot promise work that appendAsideTurn rejects.
 */
export function canAdmitAsideTurn(
  document: AsideSessionDocument | null,
  question: string,
  currentDocumentUtf8Bytes: number
): { ok: true } | { ok: false; reason: "count" | "size" | "question" } {
  const turns = document?.turns ?? [];
  if (turns.length >= MAX_ASIDE_TURNS) return { ok: false, reason: "count" };
  try {
    assertAsideQuestion(question);
  } catch {
    return { ok: false, reason: "question" };
  }
  const titleDelta = document?.title === ""
    ? Buffer.byteLength(JSON.stringify(asideTitleFromQuestion(question)), "utf8")
      - Buffer.byteLength(JSON.stringify(document.title), "utf8")
    : 0;
  if (currentDocumentUtf8Bytes + worstCaseAsideTurnUtf8Bytes(question) + titleDelta
    > MAX_ASIDE_DOCUMENT_BYTES) {
    return { ok: false, reason: "size" };
  }
  return { ok: true };
}

/**
 * Keep as much safe reasoning as the session byte cap allows. The answer is
 * never shortened. Return undefined when no reasoning scalar fits.
 */
export function truncateAsideThoughtsToFit(
  document: AsideSessionDocument,
  question: string,
  answer: string,
  thoughts: string | undefined,
  thoughtTokens?: number
): string | undefined {
  if (thoughts === undefined) return undefined;
  assertAsideQuestion(question);
  assertAsideAnswer(answer);
  assertAsideSessionDocument(document);
  const scalars = [...thoughts].slice(0, MAX_ASIDE_THOUGHT_SCALARS);
  let low = 0;
  let high = scalars.length;
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = scalars.slice(0, middle).join("");
    const next = {
      schemaVersion: ASIDE_SESSION_SCHEMA_VERSION,
      anchor: document.anchor === null ? null : { ...document.anchor },
      title: document.title === "" ? asideTitleFromQuestion(question) : document.title,
      turns: [...document.turns, {
        q: question,
        a: answer,
        thoughts: candidate,
        ...(thoughtTokens === undefined ? {} : { thoughtTokens })
      }]
    } satisfies AsideSessionDocument;
    try {
      assertAsideSessionDocument(next);
      best = candidate;
      low = middle + 1;
    } catch (error) {
      if (!(error instanceof AsideDocumentError)) throw error;
      high = middle - 1;
    }
  }
  return best === "" ? undefined : best;
}

/** Validate an immutable session anchor. */
export function assertAsideAnchor(anchor: AsideAnchor | null): void {
  if (anchor === null) return;
  if (typeof anchor !== "object" || Array.isArray(anchor)) {
    throw new AsideDocumentError("Aside session anchor must be an object or null");
  }
  const keys = Object.keys(anchor);
  if (keys.length !== 2 || !keys.includes("partId") || !keys.includes("takeId")) {
    throw new AsideDocumentError("Aside session anchor has unknown or missing keys");
  }
  assertAsideIdentifier(anchor.partId, "partId");
  assertAsideIdentifier(anchor.takeId, "takeId");
}

function assertAsideIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AsideDocumentError(`Aside session ${label} must be a non-empty string`);
  }
  if (hasUnpairedSurrogate(value)) {
    throw new AsideDocumentError(`Aside session ${label} contains an unpaired Unicode surrogate`);
  }
  if (value.normalize("NFC") !== value) {
    throw new AsideDocumentError(`Aside session ${label} must be NFC-normalized`);
  }
  if (unicodeScalarLength(value, 1_024 + 1) > 1_024) {
    throw new AsideDocumentError(`Aside session ${label} exceeds 1,024 Unicode scalars`);
  }
}

/** Validate a bounded session title. Empty titles are allowed for a new chat. */
export function assertAsideTitle(title: string): void {
  if (typeof title !== "string") {
    throw new AsideDocumentError("Aside session title must be a string");
  }
  if (hasUnpairedSurrogate(title)) {
    throw new AsideDocumentError("Aside session title contains an unpaired Unicode surrogate");
  }
  if (unicodeScalarLength(title, MAX_ASIDE_TITLE_SCALARS + 1) > MAX_ASIDE_TITLE_SCALARS) {
    throw new AsideDocumentError(
      `Aside session title exceeds ${MAX_ASIDE_TITLE_SCALARS.toLocaleString()} Unicode scalars`
    );
  }
}

/** Validate an optional retained reasoning block. */
export function assertAsideThoughts(thoughts: string): void {
  if (typeof thoughts !== "string") {
    throw new AsideDocumentError("Aside turn thoughts must be a string");
  }
  if (hasUnpairedSurrogate(thoughts)) {
    throw new AsideDocumentError("Aside turn thoughts contain an unpaired Unicode surrogate");
  }
  if (unicodeScalarLength(thoughts, MAX_ASIDE_THOUGHT_SCALARS + 1) > MAX_ASIDE_THOUGHT_SCALARS) {
    throw new AsideDocumentError(
      `Aside turn thoughts exceed ${MAX_ASIDE_THOUGHT_SCALARS.toLocaleString()} Unicode scalars`
    );
  }
}

function assertAsideThoughtTokens(tokenCount: number | undefined, thoughts: string | undefined): void {
  if (tokenCount === undefined) return;
  if (thoughts === undefined) {
    throw new AsideDocumentError("Aside turn thoughtTokens requires thoughts");
  }
  if (!Number.isSafeInteger(tokenCount) || tokenCount < 0) {
    throw new AsideDocumentError("Aside turn thoughtTokens must be a non-negative integer");
  }
}

/** Make the display title used when a session receives its first question. */
export function asideTitleFromQuestion(question: string): string {
  assertAsideQuestion(question);
  const collapsed = question.trim().replace(/\s+/gu, " ");
  const scalars = [...collapsed];
  return scalars.slice(0, MAX_ASIDE_TITLE_SCALARS).join("");
}

/** Create an empty v2 session. Its title is set on the first appended turn. */
export function emptyAsideSessionDocument(
  anchor: AsideAnchor | null,
  title = ""
): AsideSessionDocument {
  assertAsideAnchor(anchor);
  assertAsideTitle(title);
  return {
    schemaVersion: ASIDE_SESSION_SCHEMA_VERSION,
    anchor: anchor === null ? null : { partId: anchor.partId, takeId: anchor.takeId },
    title,
    turns: []
  };
}

/** Validate one v2 turn. */
export function assertAsideTurn(turn: AsideTurn): void {
  if (turn === null || typeof turn !== "object" || Array.isArray(turn)) {
    throw new AsideDocumentError("Aside turn must be an object");
  }
  const keys = Object.keys(turn);
  if (keys.some((key) => key !== "q" && key !== "a" && key !== "thoughts" && key !== "thoughtTokens")) {
    throw new AsideDocumentError("Aside turn has unknown keys");
  }
  if (!keys.includes("q") || !keys.includes("a")) {
    throw new AsideDocumentError("Aside turn must contain q and a");
  }
  assertAsideQuestion(turn.q);
  assertAsideAnswer(turn.a);
  if (turn.thoughts !== undefined) assertAsideThoughts(turn.thoughts);
  assertAsideThoughtTokens(turn.thoughtTokens, turn.thoughts);
}

/** Validate a complete v2 session. */
export function assertAsideSessionDocument(document: AsideSessionDocument): void {
  assertAsideSessionDocumentShape(document);
  const bytes = Buffer.byteLength(serializeAsideSessionDocument(document), "utf8");
  if (bytes > MAX_ASIDE_DOCUMENT_BYTES) {
    throw new AsideDocumentError(
      `Aside session would exceed its ${MAX_ASIDE_DOCUMENT_BYTES}-byte size limit`
    );
  }
}

/** Append one Q/A turn without mutating the source session. */
export function appendAsideTurn(
  document: AsideSessionDocument | null,
  question: string,
  answer: string,
  thoughts?: string,
  thoughtTokens?: number
): AsideSessionDocument {
  assertAsideQuestion(question);
  assertAsideAnswer(answer);
  if (thoughts !== undefined) assertAsideThoughts(thoughts);
  assertAsideThoughtTokens(thoughtTokens, thoughts);
  const current = document ?? emptyAsideSessionDocument(null);
  assertAsideSessionDocument(current);
  if (current.turns.length >= MAX_ASIDE_TURNS) {
    throw new AsideDocumentError(
      `Aside session already holds ${MAX_ASIDE_TURNS} turns; clear it before adding more`
    );
  }
  const turn: AsideTurn = {
    q: question,
    a: answer,
    ...(thoughts === undefined ? {} : { thoughts }),
    ...(thoughtTokens === undefined ? {} : { thoughtTokens })
  };
  const next: AsideSessionDocument = {
    schemaVersion: ASIDE_SESSION_SCHEMA_VERSION,
    anchor: current.anchor === null ? null : { ...current.anchor },
    title: current.title === "" ? asideTitleFromQuestion(question) : current.title,
    turns: [...current.turns, turn]
  };
  assertAsideSessionDocument(next);
  return next;
}

/** Replace one turn's answer and optional thoughts, preserving its question. */
export function replaceAsideTurn(
  document: AsideSessionDocument,
  index: number,
  answer: string,
  thoughts?: string,
  thoughtTokens?: number
): AsideSessionDocument {
  assertAsideSessionDocument(document);
  assertAsideIndex(document, index);
  assertAsideAnswer(answer);
  if (thoughts !== undefined) assertAsideThoughts(thoughts);
  assertAsideThoughtTokens(thoughtTokens, thoughts);
  const prior = document.turns[index]!;
  const turn: AsideTurn = {
    q: prior.q,
    a: answer,
    ...(thoughts === undefined ? {} : { thoughts }),
    ...(thoughtTokens === undefined ? {} : { thoughtTokens })
  };
  const next = {
    schemaVersion: ASIDE_SESSION_SCHEMA_VERSION,
    anchor: document.anchor === null ? null : { ...document.anchor },
    title: document.title,
    turns: document.turns.map((candidate, position) => position === index ? turn : candidate)
  } satisfies AsideSessionDocument;
  assertAsideSessionDocument(next);
  return next;
}

/** Remove one turn and return a new session. */
export function deleteAsideTurn(document: AsideSessionDocument, index: number): AsideSessionDocument {
  assertAsideSessionDocument(document);
  assertAsideIndex(document, index);
  const next = {
    schemaVersion: ASIDE_SESSION_SCHEMA_VERSION,
    anchor: document.anchor === null ? null : { ...document.anchor },
    title: document.title,
    turns: document.turns.filter((_turn, position) => position !== index)
  } satisfies AsideSessionDocument;
  assertAsideSessionDocument(next);
  return next;
}

/** Keep the focused turn and all earlier turns; this is the reset-to-here verb. */
export function resetAsideSession(document: AsideSessionDocument, index: number): AsideSessionDocument {
  assertAsideSessionDocument(document);
  assertAsideIndex(document, index);
  const next = {
    schemaVersion: ASIDE_SESSION_SCHEMA_VERSION,
    anchor: document.anchor === null ? null : { ...document.anchor },
    title: document.title,
    turns: document.turns.slice(0, index + 1)
  } satisfies AsideSessionDocument;
  assertAsideSessionDocument(next);
  return next;
}

/** Regenerate the last answer in a session. */
export function retakeAsideSession(
  document: AsideSessionDocument,
  answer: string,
  thoughts?: string,
  thoughtTokens?: number
): AsideSessionDocument {
  assertAsideSessionDocument(document);
  if (document.turns.length === 0) {
    throw new AsideDocumentError("Aside session has no turn to retake");
  }
  return replaceAsideTurn(document, document.turns.length - 1, answer, thoughts, thoughtTokens);
}

function assertAsideIndex(document: AsideSessionDocument, index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= document.turns.length) {
    throw new AsideDocumentError("Aside turn index is out of range");
  }
}

/** Canonical JSON for one v2 session. */
export function serializeAsideSessionDocument(document: AsideSessionDocument): string {
  assertAsideSessionDocumentShape(document);
  const turns = document.turns.map((turn) => ({
    q: turn.q,
    a: turn.a,
    ...(turn.thoughts === undefined ? {} : { thoughts: turn.thoughts }),
    ...(turn.thoughtTokens === undefined ? {} : { thoughtTokens: turn.thoughtTokens })
  }));
  return JSON.stringify({
    schemaVersion: ASIDE_SESSION_SCHEMA_VERSION,
    anchor: document.anchor === null ? null : {
      partId: document.anchor.partId,
      takeId: document.anchor.takeId
    },
    title: document.title,
    turns
  });
}

/** Content identity for the exact serialized v2 session object. */
export function hashAsideSessionDocument(document: AsideSessionDocument): string {
  return createHash("sha256")
    .update(Buffer.from(serializeAsideSessionDocument(document), "utf8"))
    .digest("hex");
}

function assertAsideSessionDocumentShape(document: AsideSessionDocument): void {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new AsideDocumentError("Aside session must be an object");
  }
  const keys = Object.keys(document);
  if (keys.length !== 4 || !keys.includes("schemaVersion") || !keys.includes("anchor")
    || !keys.includes("title") || !keys.includes("turns")) {
    throw new AsideDocumentError("Aside session has unknown or missing keys");
  }
  if (document.schemaVersion !== ASIDE_SESSION_SCHEMA_VERSION) {
    throw new AsideDocumentError("Aside session schemaVersion is unsupported");
  }
  assertAsideAnchor(document.anchor);
  assertAsideTitle(document.title);
  if (!Array.isArray(document.turns)) throw new AsideDocumentError("Aside session turns must be an array");
  if (document.turns.length > MAX_ASIDE_TURNS) {
    throw new AsideDocumentError(`Aside session exceeds the ${MAX_ASIDE_TURNS}-turn limit`);
  }
  for (const turn of document.turns) assertAsideTurn(turn);
}

/** Parse and hash-check one v2 session document. */
export function parseAsideSessionDocument(raw: string, expectedHash?: string): AsideSessionDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new AsideDocumentError("Aside session is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AsideDocumentError("Aside session must be an object");
  }
  const document = value as AsideSessionDocument;
  assertAsideSessionDocument(document);
  if (expectedHash !== undefined) {
    const hash = createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex");
    if (hash !== expectedHash) throw new AsideDocumentError(`Aside session hash mismatch for ${expectedHash}`);
  }
  return {
    schemaVersion: ASIDE_SESSION_SCHEMA_VERSION,
    anchor: document.anchor === null ? null : { ...document.anchor },
    title: document.title,
    turns: document.turns.map((turn) => ({
      q: turn.q,
      a: turn.a,
      ...(turn.thoughts === undefined ? {} : { thoughts: turn.thoughts }),
      ...(turn.thoughtTokens === undefined ? {} : { thoughtTokens: turn.thoughtTokens })
    }))
  };
}

/** Convert a v1 document to one lossless unanchored v2 session. */
export function migrateAsideDocumentToUnanchored(
  document: AsideDocument | null,
  title?: string
): AsideSessionDocument | null {
  if (document === null) return null;
  assertAsideDocument(document);
  const turns = document.notes.map((note) => ({ q: note.question, a: note.answer }));
  const migrated: AsideSessionDocument = {
    schemaVersion: ASIDE_SESSION_SCHEMA_VERSION,
    anchor: null,
    // Keep V1 projection byte-neutral. A derived title can push a document
    // near the shared byte cap over the limit; view boundaries derive it
    // without changing this migrated content.
    title: title ?? "",
    turns
  };
  assertAsideSessionDocument(migrated);
  return migrated;
}

/** Return the v2 session's prompt-visible history. Thoughts are excluded. */
export function asideHistoryFromSession(
  document: AsideSessionDocument | null
): readonly SideNote[] {
  return document?.turns.map((turn) => ({ question: turn.q, answer: turn.a })) ?? [];
}

export type {
  AsidePresenceSummary,
  AsideSessionIndex,
  AsideSessionRef
} from "./aside-session-index.js";
