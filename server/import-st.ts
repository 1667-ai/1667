import { ServiceError as HttpError } from "./errors.js";
import { sliceWellFormedUtf16Prefix } from "../shared/unicode.js";
import { countNoun } from "../shared/fidelity.js";
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
  /** Group-chat assistant messages whose sender name was added to the prose
   *  because the source message did not name its own speaker. */
  addedGroupChatSpeakerPrefixes: number;
  /** Unanswered user turns at the end of the chat. Deliberately not imported:
   *  they carry no assistant-authored story text, and the source file still has
   *  them. The CLI reports the count; the UI treats the import as complete. */
  droppedTrailingUserMessages: number;
  /** A message's `swipes` beyond the room the part or text budget had left,
   *  once the active swipe and every other message already fit. Best effort:
   *  a chat that carries more swipe history than 1667 can hold still imports
   *  its active storyline in full. */
  omittedAlternateSwipes: number;
}

/** The Fidelity Report for a SillyTavern import, in the same shape the
 *  NovelAI and Scenario importers already report. */
export function sillyTavernFidelity(
  imported: Pick<
    SillyTavernImport,
    | "addedGroupChatSpeakerPrefixes"
    | "droppedTrailingUserMessages"
    | "omittedAlternateSwipes"
  >
): string[] {
  const fidelity: string[] = [];
  const addedGroupChatSpeakerPrefixes = imported.addedGroupChatSpeakerPrefixes;
  if (addedGroupChatSpeakerPrefixes > 0) {
    fidelity.push(
      `${addedGroupChatSpeakerPrefixes} group-chat speaker `
        + `${countNoun(addedGroupChatSpeakerPrefixes, "label")} added to prose`
    );
  }
  if (imported.omittedAlternateSwipes > 0) {
    fidelity.push(
      `${imported.omittedAlternateSwipes} unselected ${countNoun(imported.omittedAlternateSwipes, "swipe")} omitted`
    );
  }
  if (imported.droppedTrailingUserMessages > 0) {
    fidelity.push(
      `${imported.droppedTrailingUserMessages} trailing user `
        + `${countNoun(imported.droppedTrailingUserMessages, "message")} dropped`
    );
  }
  return fidelity;
}

// A byte cap bounds the *input*, not the work: 20MB of one-word lines is millions
// of records, and a long name times many {{char}} macros expands far past the input
// size. Every dimension that can amplify gets its own budget.
const MAX_RECORDS = 50_000;
export const MAX_SWIPE_RECORDS = 50_000;
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
  isNarrator: boolean;
  name: string;
  sendDate: unknown;
  /** Every generated candidate for this message, `mes` among them — a
   *  SillyTavern "swipe". A one-item list can be a stale alternate when it
   *  does not match `mes`. */
  swipes: unknown;
  /** Index into `swipes` that `mes` came from. */
  swipeId: unknown;
  /** Parallel to `swipes`; each entry's `send_date` becomes that
   *  alternate's `createdAt`, when it parses. */
  swipeInfo: unknown;
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
  let swipeRecords = 0;
  // Headerless files replay their first line as a record, so it must not be pre-counted.
  let records = hasMeta ? 1 : 0;
  for (const line of hasMeta ? lines : prepend(first.value, lines)) {
    if (++records > MAX_RECORDS) throw new HttpError(400, `Chat has more than ${MAX_RECORDS} records — too large to import`);
    const message = parseLine(line);
    if (message === null || typeof message.mes !== "string") continue;
    if (message.is_system === true) continue;
    if (message.mes.trim().length === 0) continue;
    if (Array.isArray(message.swipes)) {
      swipeRecords += message.swipes.length;
      if (swipeRecords > MAX_SWIPE_RECORDS) {
        throw new HttpError(
          400,
          `Chat has more than ${MAX_SWIPE_RECORDS} swipe records — too large to import`
        );
      }
    }
    raw.push({
      mes: message.mes,
      isUser: message.is_user === true,
      isNarrator: isNarratorMessage(message.extra),
      name: typeof message.name === "string" ? message.name : "",
      sendDate: message.send_date,
      swipes: message.swipes,
      swipeId: message.swipe_id,
      swipeInfo: message.swipe_info
    });
  }

  const userName = resolveName(hasMeta ? meta.user_name : undefined, raw, true);
  const characterName = resolveName(hasMeta ? meta.character_name : undefined, raw, false);
  // A normal chat has one assistant speaker. Keep its text byte-identical.
  // More than one real assistant name is the shape SillyTavern uses for a
  // group chat, where `character_name` may be absent or a stale sentinel.
  // Discarded macro-expanded blanks cannot turn a surviving one-speaker chat
  // into a group and cause attribution labels to be added to its prose.
  const isGroupChat = new Set(
    raw
      .filter((message) => !message.isUser && !message.isNarrator && expansionHasContent(
        message.mes,
        (kind) => kind.toLowerCase() === "user"
          ? userName
          : messageSpeakerName(message) || characterName
      ))
      .map(messageSpeakerName)
      .filter((name) => name.length > 0)
      .map(speakerIdentityKey)
  ).size > 1;

  let remaining = MAX_TOTAL_CHARS;
  const macroName = (kind: string, message: RawMessage): string => {
    if (kind.toLowerCase() === "user") return userName;
    if (!isGroupChat || message.isUser || message.isNarrator) return characterName;
    return messageSpeakerName(message) || characterName;
  };
  const projectExpansion = (text: string, message: RawMessage): number => {
    // Project the exact expanded size BEFORE substituting: a 200-char name times
    // 100k macros is a half-gigabyte string that would be allocated, then rejected.
    let projected = text.length;
    for (const match of text.matchAll(MACROS)) {
      const name = macroName(match[1]!, message);
      projected += name.length - MACRO_LENGTH;
    }
    return projected;
  };
  const substitute = (text: string, message: RawMessage): string =>
    text.replace(MACROS, (_match, kind: string) => macroName(kind, message));
  const expand = (
    text: string,
    message: RawMessage,
    repeatedChars = 0,
    omitOnOverflow = false
  ): { text: string; addedSpeakerPrefix: boolean } | null => {
    // A macro can turn nonblank source into blank prose. Detect that without
    // allocating the expansion, and before enforcing a budget for text that
    // will never be stored.
    if (!expansionHasContent(text, (kind) => macroName(kind, message))) return null;
    const projected = projectExpansion(text, message) + repeatedChars;
    if (projected > remaining) {
      if (omitOnOverflow) return null;
      throw new HttpError(400, "Chat expands to more text than can be imported");
    }
    const expanded = substitute(text, message);
    // Decide attribution after macro substitution and blank rejection. This
    // prevents label-only parts and avoids prefixing prose that {{char}}
    // already expanded to identify.
    const prefix = groupChatSpeakerPrefix(expanded, message, isGroupChat);
    const charged = projected + prefix.length;
    if (charged > remaining) {
      if (omitOnOverflow) return null;
      throw new HttpError(400, "Chat expands to more text than can be imported");
    }
    remaining -= charged;
    return { text: prefix + expanded, addedSpeakerPrefix: prefix.length > 0 };
  };

  // Two passes, deliberately: the whole active storyline claims its budget
  // first, in message order, so one large early alternate can never starve a
  // later active message of the room or characters it needs. Only once every
  // active part is safely in does the second pass spend what is left on
  // alternates, which are optional and may be dropped for want of room.
  const parts: ImportedPart[] = [];
  const pendingUser: RawMessage[] = [];
  const activeEntries: { parentIndex: number | null; instruction: string; message: RawMessage }[] = [];
  let addedGroupChatSpeakerPrefixes = 0;
  // The active storyline's own chain, tracked explicitly: once a message's
  // alternate swipes are appended after its active take, the *previous array
  // element* is an alternate, not the take the next active part continues.
  let previousActiveIndex: number | null = null;
  for (const message of raw) {
    if (message.isUser) {
      if (expansionHasContent(message.mes, (kind) => macroName(kind, message))) {
        pendingUser.push(message);
      }
      continue;
    }
    const instructionChars = pendingUser.reduce(
      (total, pending) => total + projectExpansion(pending.mes, pending),
      Math.max(0, pendingUser.length - 1) * 2
    );
    const expanded = expand(message.mes, message, instructionChars);
    // Expansion can empty a message: a greeting of just "{{user}}" with no
    // resolvable name becomes "". An empty part would later be sent to the
    // provider as empty assistant content, which providers reject.
    if (expanded === null) continue;
    const text = expanded.text;
    // Pending user turns cost nothing until an assistant part retains them as
    // its instruction. The exact expansion plus separators was reserved by
    // `expand` above, before any potentially amplified string was allocated.
    const instruction = pendingUser
      .map((pending) => substitute(pending.mes, pending))
      .join("\n\n");
    const activeIndex = parts.length;
    parts.push({ instruction, text, createdAt: parseSendDate(message.sendDate), parentIndex: previousActiveIndex });
    if (expanded.addedSpeakerPrefix) addedGroupChatSpeakerPrefixes += 1;
    pendingUser.length = 0;
    if (parts.length > MAX_PARTS) throw new HttpError(400, `Chat has more than ${MAX_PARTS} messages — too large to import`);

    activeEntries.push({ parentIndex: previousActiveIndex, instruction, message });
    previousActiveIndex = activeIndex;
  }

  if (parts.length === 0) throw new HttpError(400, "No importable messages found (not a SillyTavern chat JSONL?)");

  let omittedAlternateSwipes = 0;
  for (const entry of activeEntries) {
    const alternates = addAlternateSwipes(parts, entry.parentIndex, entry.instruction, entry.message, {
      tryExpand: (text, message, repeatedChars) => expand(text, message, repeatedChars, true),
      hasRoom: () => parts.length < MAX_PARTS
    });
    omittedAlternateSwipes += alternates.omitted;
    addedGroupChatSpeakerPrefixes += alternates.addedSpeakerPrefixes;
  }

  return {
    title: characterName.length > 0 ? `${characterName} (imported)` : "Imported chat",
    parts,
    addedGroupChatSpeakerPrefixes,
    droppedTrailingUserMessages: pendingUser.length,
    omittedAlternateSwipes
  };
}

/** Which `swipes` entry is `mes`. Trusts `swipe_id` only when it is in bounds
 *  and that entry's text actually equals `mes`; a stale or corrupt index must
 *  not hide a legitimate alternate. Falls back to the entry whose text equals
 *  `mes`. When no entry matches at all, returns `null` — the caller then
 *  excludes no index, so every swipe still imports rather than one vanishing
 *  on a guess. */
function resolveActiveSwipeIndex(swipes: readonly unknown[], swipeId: unknown, mes: string): number | null {
  if (Number.isInteger(swipeId)) {
    const index = swipeId as number;
    if (index >= 0 && index < swipes.length && swipes[index] === mes) return index;
  }
  const matched = swipes.findIndex((entry) => entry === mes);
  return matched === -1 ? null : matched;
}

/** A message's other swipes become alternate takes, siblings of its active
 *  take — the same position in the storyline, a different generation.
 *  Returns how many were dropped for want of room or budget. */
function addAlternateSwipes(
  parts: ImportedPart[],
  parentIndex: number | null,
  instruction: string,
  message: RawMessage,
  budget: {
    tryExpand: (
      text: string,
      message: RawMessage,
      repeatedChars?: number
    ) => { text: string; addedSpeakerPrefix: boolean } | null;
    hasRoom: () => boolean;
  }
): { omitted: number; addedSpeakerPrefixes: number } {
  if (!Array.isArray(message.swipes) || message.swipes.length === 0) {
    return { omitted: 0, addedSpeakerPrefixes: 0 };
  }
  const activeSwipeIndex = resolveActiveSwipeIndex(message.swipes, message.swipeId, message.mes);
  const swipeInfo = Array.isArray(message.swipeInfo) ? message.swipeInfo : [];
  let omitted = 0;
  let addedSpeakerPrefixes = 0;
  for (let index = 0; index < message.swipes.length; index += 1) {
    if (index === activeSwipeIndex) continue;
    const rawText: unknown = message.swipes[index];
    if (typeof rawText !== "string") {
      omitted += 1;
      continue;
    }
    if (!budget.hasRoom()) {
      omitted += 1;
      continue;
    }
    // Every alternate stores its own copy of the active take's instruction.
    // Charge that duplicate as well as the alternate prose.
    const expanded = budget.tryExpand(rawText, message, instruction.length);
    if (expanded === null) {
      omitted += 1;
      continue;
    }
    const info: unknown = swipeInfo[index];
    const sendDate = info !== null && typeof info === "object" && !Array.isArray(info)
      ? (info as Record<string, unknown>).send_date
      : undefined;
    parts.push({
      instruction,
      text: expanded.text,
      createdAt: parseSendDate(sendDate),
      parentIndex,
      active: false
    });
    if (expanded.addedSpeakerPrefix) addedSpeakerPrefixes += 1;
  }
  return { omitted, addedSpeakerPrefixes };
}

/** Header names are unreliable — SillyTavern writes "unused" in some exports — so
 *  fall back to the speaker name on the first matching message. */
function resolveName(headerValue: unknown, raw: readonly RawMessage[], wantUser: boolean): string {
  const header = typeof headerValue === "string" ? headerValue.trim() : "";
  if (header.length > 0 && !PLACEHOLDER_NAMES.has(header.toLowerCase())) {
    return sliceWellFormedUtf16Prefix(header, MAX_NAME);
  }
  const speaker = raw.find((message) =>
    message.isUser === wantUser
    && (wantUser || !message.isNarrator)
    && message.name.trim().length > 0
  );
  const name = speaker?.name.trim() ?? "";
  return PLACEHOLDER_NAMES.has(name.toLowerCase()) ? "" : sliceWellFormedUtf16Prefix(name, MAX_NAME);
}

/** A group-chat message has no durable speaker field in the story model. Add
 *  only a missing name; prose that already names its speaker remains intact. */
function groupChatSpeakerPrefix(text: string, message: RawMessage, isGroupChat: boolean): string {
  if (!isGroupChat || message.isUser || message.isNarrator) return "";
  const name = messageSpeakerName(message);
  if (name.length === 0 || containsSpeakerName(text, name)) return "";
  return `${name}: `;
}

function containsSpeakerName(text: string, name: string): boolean {
  const lowerText = speakerIdentityKey(text);
  const lowerName = speakerIdentityKey(name);
  // Alphabetic names need token boundaries: "Анна" inside "Жанна" and "Ann"
  // inside "Planning" are not attribution. CJK scripts retain substring
  // matching because their prose does not normally delimit names with spaces.
  const usesCjkWordBoundaries = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
    .test(lowerName);
  if (!usesCjkWordBoundaries && /[\p{L}\p{N}]/u.test(lowerName)) {
    const escaped = lowerName.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    return new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`,
      "u"
    ).test(lowerText);
  }
  return lowerText.includes(lowerName);
}

function messageSpeakerName(message: Pick<RawMessage, "name">): string {
  const name = message.name.trim();
  if (name.length === 0 || PLACEHOLDER_NAMES.has(name.toLowerCase())) return "";
  return sliceWellFormedUtf16Prefix(name, MAX_NAME);
}

function speakerIdentityKey(name: string): string {
  // Upper-then-lower performs the multi-code-point folds plain lowercasing
  // misses (for example ß/SS and Greek final sigma), without locale-specific
  // rules changing identity between hosts.
  return name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

function isNarratorMessage(extra: unknown): boolean {
  return extra !== null
    && typeof extra === "object"
    && !Array.isArray(extra)
    && (extra as Record<string, unknown>).type === "narrator";
}

/** Whether macro substitution can produce retained prose, without allocating
 *  the expanded string. Names are already trimmed at their resolution boundary. */
function expansionHasContent(text: string, macroName: (kind: string) => string): boolean {
  let cursor = 0;
  for (const match of text.matchAll(MACROS)) {
    const index = match.index;
    if (text.slice(cursor, index).trim().length > 0) return true;
    if (macroName(match[1]!).length > 0) return true;
    cursor = index + match[0].length;
  }
  return text.slice(cursor).trim().length > 0;
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
