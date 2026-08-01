import { ServiceError as HttpError } from "./errors.js";
import { sliceWellFormedUtf16Prefix } from "../shared/unicode.js";
import {
  MAX_PARTS,
  MAX_TOTAL_CHARS,
  type ImportedPart
} from "./import-model.js";
export {
  MAX_IMPORT_BYTES,
  MAX_PARTS,
  MAX_TOTAL_CHARS,
  storyFromImport,
  type GenericImport,
  type ImportedPart
} from "./import-model.js";

export interface SillyTavernImport {
  title: string;
  parts: ImportedPart[];
  /** Unanswered user turns at the end of the chat. Deliberately not imported:
   *  they carry no assistant-authored story text, and the source file still has
   *  them. The CLI reports the count; the UI treats the import as complete. */
  droppedTrailingUserMessages: number;
}

// A byte cap bounds the *input*, not the work: 20MB of one-word lines is millions
// of records, and a long name times many {{char}} macros expands far past the input
// size. Every dimension that can amplify gets its own budget.
const MAX_RECORDS = 50_000;
export const MAX_NAME = 200;

/** One pattern, one pass. Two sequential replaces would let a name containing
 *  "{{char}}" inject macros that the next pass expands again — a small file could
 *  then amplify without limit. String.replace never rescans what it inserted. */
const MACROS = /\{\{(user|char)\}\}/gi;
const MACRO_LENGTH = "{{user}}".length;

/** SillyTavern's own converters write sentinels instead of real names. */
const PLACEHOLDER_NAMES = new Set(["", "unused"]);

interface RawMessage {
  mes: string;
  isUser: boolean;
  name: string;
  sendDate: unknown;
}

/**
 * Map a SillyTavern chat JSONL export to story parts. The first line is chat
 * metadata; each further line is a message. Consecutive user messages accumulate
 * into the instruction of the next assistant message's part; system messages,
 * empty messages, and malformed lines are skipped.
 */
export function partsFromSillyTavernJsonl(jsonl: string): SillyTavernImport {
  const lines = iterateLines(jsonl);
  const first = lines.next();
  if (first.done === true) throw new HttpError(400, "Empty file");

  const meta = parseLine(first.value);
  // A metadata line has no `mes`; a file without one starts at messages directly.
  const hasMeta = meta !== null && typeof meta.mes !== "string";

  // Collect first, substitute later: names may only be discoverable from the
  // messages themselves, and every expansion has to be budgeted before it runs.
  const raw: RawMessage[] = [];
  // Headerless files replay their first line as a record, so it must not be pre-counted.
  let records = hasMeta ? 1 : 0;
  for (const line of hasMeta ? lines : prepend(first.value, lines)) {
    if (++records > MAX_RECORDS) throw new HttpError(400, `Chat has more than ${MAX_RECORDS} records — too large to import`);
    const message = parseLine(line);
    if (message === null || typeof message.mes !== "string") continue;
    if (message.is_system === true) continue;
    if (message.mes.trim().length === 0) continue;
    raw.push({
      mes: message.mes,
      isUser: message.is_user === true,
      name: typeof message.name === "string" ? message.name : "",
      sendDate: message.send_date
    });
  }

  const userName = resolveName(hasMeta ? meta.user_name : undefined, raw, true);
  const characterName = resolveName(hasMeta ? meta.character_name : undefined, raw, false);

  let remaining = MAX_TOTAL_CHARS;
  const expand = (text: string): string => {
    // Project the exact expanded size BEFORE substituting: a 200-char name times
    // 100k macros is a half-gigabyte string that would be allocated, then rejected.
    let projected = text.length;
    for (const match of text.matchAll(MACROS)) {
      const name = match[1]!.toLowerCase() === "user" ? userName : characterName;
      projected += name.length - MACRO_LENGTH;
    }
    remaining -= Math.max(text.length, projected);
    if (remaining < 0) throw new HttpError(400, "Chat expands to more text than can be imported");
    return text.replace(MACROS, (_match, kind: string) => (kind.toLowerCase() === "user" ? userName : characterName));
  };

  const parts: ImportedPart[] = [];
  const pendingUser: string[] = [];
  for (const message of raw) {
    const text = expand(message.mes);
    // Expansion can empty a message: a greeting of just "{{user}}" with no
    // resolvable name becomes "". An empty part would later be sent to the
    // provider as empty assistant content, which providers reject.
    if (text.trim().length === 0) continue;
    if (message.isUser) {
      pendingUser.push(text);
      continue;
    }
    parts.push({ instruction: pendingUser.join("\n\n"), text, createdAt: parseSendDate(message.sendDate) });
    pendingUser.length = 0;
    if (parts.length > MAX_PARTS) throw new HttpError(400, `Chat has more than ${MAX_PARTS} messages — too large to import`);
  }

  if (parts.length === 0) throw new HttpError(400, "No importable messages found (not a SillyTavern chat JSONL?)");
  return {
    title: characterName.length > 0 ? `${characterName} (imported)` : "Imported chat",
    parts,
    droppedTrailingUserMessages: pendingUser.length
  };
}

/** Header names are unreliable — SillyTavern writes "unused" in some exports — so
 *  fall back to the speaker name on the first matching message. */
function resolveName(headerValue: unknown, raw: readonly RawMessage[], wantUser: boolean): string {
  const header = typeof headerValue === "string" ? headerValue.trim() : "";
  if (header.length > 0 && !PLACEHOLDER_NAMES.has(header.toLowerCase())) {
    return sliceWellFormedUtf16Prefix(header, MAX_NAME);
  }
  const speaker = raw.find((message) => message.isUser === wantUser && message.name.trim().length > 0);
  const name = speaker?.name.trim() ?? "";
  return PLACEHOLDER_NAMES.has(name.toLowerCase()) ? "" : sliceWellFormedUtf16Prefix(name, MAX_NAME);
}

/** Walk lines without materializing them: a 20MB body of tiny lines would
 *  otherwise become millions of array entries before the first budget check. */
function* iterateLines(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (line.length > 0) yield line;
  }
}

function* prepend(value: string, rest: Generator<string>): Generator<string> {
  yield value;
  yield* rest;
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Malformed line: skipped by the caller.
  }
  return null;
}

// Best effort only: epoch millis and Date.parse-able strings. ST's own display
// format ("2024-6-30 @14h 30m 12s 123ms") falls through to the import time.
function parseSendDate(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string") {
    const millis = /^\d{10,}$/.test(value.trim()) ? Number(value) : Date.parse(value);
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}
