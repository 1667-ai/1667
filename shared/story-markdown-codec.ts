import { MAX_STORED_TITLE_CHARS } from "./types.js";
import { unicodeScalarLength } from "./unicode.js";

export const STORY_MARKDOWN_EXPORT_MARKER = "<!-- 1667:export:v1 -->";

const STORY_TITLE_PREFIX = "<!-- 1667:story-title:v1:";
const CHAPTER_PREFIX = "<!-- 1667:chapter:v1";
const MARKER_SUFFIX = " -->";
const MAX_TITLE_UTF8_BYTES = MAX_STORED_TITLE_CHARS * 4;

export interface MarkdownChapterMarker {
  /** Null means the following visible H2 owns the exact title. */
  readonly title: string | null;
  readonly display: string | null;
}

export interface MarkdownStoryTitleMarker {
  readonly title: string;
  readonly display: string;
}

export function markdownDisplayTitle(title: string, fallback: string): string {
  const display = title.replace(/\r\n?|\n/g, " ").trim();
  return display.length === 0 ? fallback : display;
}

export function markdownStoryTitleMarker(title: string, display: string): string | null {
  return title === display
    ? null
    : `${STORY_TITLE_PREFIX}${encodeTitle(display)}.${encodeTitle(title)}${MARKER_SUFFIX}`;
}

export function markdownChapterMarker(title: string, display: string): string {
  return title === display
    ? `${CHAPTER_PREFIX}${MARKER_SUFFIX}`
    : `${CHAPTER_PREFIX}:${encodeTitle(display)}.${encodeTitle(title)}${MARKER_SUFFIX}`;
}

/** Escape the reserved namespace bijectively; existing zero-width escapes are doubled. */
export function escapeStoryMarkdownProse(prose: string): string {
  return prose.replace(
    /(^|[\r\n])<!--(\u200B*) 1667:/gu,
    "$1<!--\u200B$2 1667:"
  );
}

export function unescapeStoryMarkdownProse(prose: string): string {
  return prose.replace(
    /(^|[\r\n])<!--\u200B(\u200B*) 1667:/gu,
    "$1<!--$2 1667:"
  );
}

export function decodeMarkdownStoryTitleMarker(
  line: string
): MarkdownStoryTitleMarker | undefined {
  if (!line.startsWith(STORY_TITLE_PREFIX) || !line.endsWith(MARKER_SUFFIX)) return undefined;
  const fields = encodedTitlePair(
    line.slice(STORY_TITLE_PREFIX.length, -MARKER_SUFFIX.length)
  );
  return { display: decodeTitle(fields.display), title: decodeTitle(fields.title) };
}

export function decodeMarkdownChapterMarker(line: string): MarkdownChapterMarker | undefined {
  const plain = `${CHAPTER_PREFIX}${MARKER_SUFFIX}`;
  if (line === plain) return { display: null, title: null };
  const encodedPrefix = `${CHAPTER_PREFIX}:`;
  if (!line.startsWith(encodedPrefix) || !line.endsWith(MARKER_SUFFIX)) return undefined;
  const fields = encodedTitlePair(
    line.slice(encodedPrefix.length, -MARKER_SUFFIX.length)
  );
  return { display: decodeTitle(fields.display), title: decodeTitle(fields.title) };
}

function encodedTitlePair(value: string): { display: string; title: string } {
  const separator = value.indexOf(".");
  if (separator < 0 || value.indexOf(".", separator + 1) >= 0) {
    throw new Error("invalid 1667 Markdown title marker");
  }
  return { display: value.slice(0, separator), title: value.slice(separator + 1) };
}

function encodeTitle(title: string): string {
  return Buffer.from(title, "utf8").toString("base64url");
}

function decodeTitle(encoded: string): string {
  if (!/^[A-Za-z0-9_-]*$/u.test(encoded)) throw new Error("invalid 1667 Markdown title marker");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded || bytes.byteLength > MAX_TITLE_UTF8_BYTES) {
    throw new Error("invalid 1667 Markdown title marker");
  }
  let title: string;
  try {
    title = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid 1667 Markdown title marker");
  }
  if (unicodeScalarLength(title, MAX_STORED_TITLE_CHARS) > MAX_STORED_TITLE_CHARS) {
    throw new Error("invalid 1667 Markdown title marker");
  }
  return title;
}
