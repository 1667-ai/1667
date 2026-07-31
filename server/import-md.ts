import { ServiceError } from "./errors.js";
import { sliceUnicodeScalarPrefix } from "../shared/unicode.js";
import {
  decodeMarkdownChapterMarker,
  decodeMarkdownStoryTitleMarker,
  STORY_MARKDOWN_EXPORT_MARKER
} from "../shared/story-markdown-codec.js";
import {
  MAX_STORY_MANIFEST_BYTES,
  MAX_STORY_TITLE_CHARS
} from "./story-v5-strict.js";
import {
  MAX_IMPORT_BYTES,
  MAX_PARTS,
  MAX_TOTAL_CHARS,
  type ImportedPart
} from "./import-st.js";

export interface MarkdownImportBreak {
  parentPartIndex: number;
  title: string;
}

export interface MarkdownImport {
  title: string;
  parts: ImportedPart[];
  chapterBreaks: MarkdownImportBreak[];
}

interface LineInfo {
  line: string;
  start: number;
  end: number;
}

interface MarkdownFence {
  marker: "`" | "~";
  length: number;
}

// Imported nodes have fixed identifiers and timestamps plus at most a 100-character
// preview in the manifest. These deliberately conservative reserves keep the exact
// V6 manifest below its hard limit even when every JSON string needs escaping.
const IMPORT_MANIFEST_ROOT_RESERVE_BYTES = 64 * 1024;
const IMPORT_MANIFEST_NODE_RESERVE_BYTES = 2 * 1024;
const IMPORT_MANIFEST_CHAPTER_RESERVE_BYTES = 512;

export function partsFromMarkdown(markdown: string, defaultTitle?: string): MarkdownImport {
  if (Buffer.byteLength(markdown) > MAX_IMPORT_BYTES) {
    throw new ServiceError(413, "Request body too large");
  }

  let title = "";
  let titleFound = false;
  const parts: ImportedPart[] = [];
  const chapterBreaks: MarkdownImportBreak[] = [];
  const chapterBreakParents = new Set<number>();
  let remainingChars = MAX_TOTAL_CHARS;
  let remainingManifestBytes = MAX_STORY_MANIFEST_BYTES
    - IMPORT_MANIFEST_ROOT_RESERVE_BYTES;
  let paragraphStart = -1;
  let paragraphEnd = -1;
  let paragraphNormalizedChars = 0;
  let pendingChapterTitle: string | null = null;

  const consumeManifestBytes = (bytes: number) => {
    remainingManifestBytes -= bytes;
    if (remainingManifestBytes < 0) {
      throw new ServiceError(400, "Markdown expands beyond the stored story manifest limit");
    }
  };

  const appendChapterBreak = (parentPartIndex: number, chapterTitle: string) => {
    if (chapterBreakParents.has(parentPartIndex)) return;
    consumeManifestBytes(
      IMPORT_MANIFEST_CHAPTER_RESERVE_BYTES
      + Buffer.byteLength(JSON.stringify(chapterTitle))
    );
    chapterBreaks.push({ parentPartIndex, title: chapterTitle });
    chapterBreakParents.add(parentPartIndex);
  };

  const flushParagraph = (stripGeneratedSeparator = false) => {
    if (paragraphStart === -1) return;
    let rawText = markdown.slice(paragraphStart, paragraphEnd);
    if (stripGeneratedSeparator) {
      if (rawText.endsWith("\r\n")) rawText = rawText.slice(0, -2);
      else if (rawText.endsWith("\n")) rawText = rawText.slice(0, -1);
    }
    paragraphStart = -1;
    paragraphEnd = -1;
    paragraphNormalizedChars = 0;
    const text = rawText.replace(/\r\n/g, "\n");
    if (text.length === 0) return;

    remainingChars -= text.length;
    if (remainingChars < 0) {
      throw new ServiceError(400, "Markdown expands to more text than can be imported");
    }

    if (parts.length >= MAX_PARTS) {
      throw new ServiceError(400, `Markdown has more than ${MAX_PARTS} parts — too large to import`);
    }

    const now = new Date().toISOString();
    parts.push({
      instruction: "",
      text,
      createdAt: now
    });
    consumeManifestBytes(IMPORT_MANIFEST_NODE_RESERVE_BYTES);

    const newPartIndex = parts.length - 1;

    if (pendingChapterTitle !== null && newPartIndex > 0) {
      const prevIndex = newPartIndex - 1;
      appendChapterBreak(prevIndex, pendingChapterTitle);
      pendingChapterTitle = null;
    } else {
      pendingChapterTitle = null;
    }
  };

  let beforeProse = true;
  let fence: MarkdownFence | null = null;
  let exportCodec = false;
  let awaitingGeneratedChapterHeading = false;
  let generatedChapterTitle: string | null = null;
  for (const { line, start, end } of iterateLineInfos(markdown)) {
    const trimmed = line.trim();

    if (beforeProse && trimmed.length === 0) continue;
    if (beforeProse) {
      const candidateTitle = atxHeadingTitle(line, 1);
      if (!titleFound && candidateTitle !== null) {
        if (candidateTitle.length > 0) {
          title = sliceUnicodeScalarPrefix(candidateTitle, MAX_STORY_TITLE_CHARS);
          titleFound = true;
        }
        continue;
      }
      if (titleFound && line === STORY_MARKDOWN_EXPORT_MARKER) {
        exportCodec = true;
        continue;
      }
      if (titleFound && exportCodec) {
        const exactTitle = decodeStoryTitleMarker(line);
        if (exactTitle !== undefined) {
          title = exactTitle;
          continue;
        }
      }
      if (titleFound && isGeneratedDerivedComment(line)) continue;
      beforeProse = false;
    }

    if (exportCodec) {
      const generatedChapter = decodeChapterMarker(line);
      if (generatedChapter !== undefined) {
        // Export inserts one blank-line separator before its marker. Inside an
        // unterminated prose fence that separator was provisionally buffered.
        flushParagraph(true);
        fence = null;
        generatedChapterTitle = generatedChapter.title;
        awaitingGeneratedChapterHeading = true;
        continue;
      }
      if (awaitingGeneratedChapterHeading) {
        if (trimmed.length === 0) continue;
        const visibleTitle = atxHeadingTitle(line, 2);
        if (visibleTitle === null) {
          throw new ServiceError(400, "1667 Markdown chapter marker is missing its heading");
        }
        pendingChapterTitle = generatedChapterTitle
          ?? sliceUnicodeScalarPrefix(visibleTitle, MAX_STORY_TITLE_CHARS);
        generatedChapterTitle = null;
        awaitingGeneratedChapterHeading = false;
        continue;
      }
    }

    if (fence !== null) {
      appendParagraphLine(line, start, end);
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }

    const openingFence = markdownFence(line);
    if (openingFence !== null) {
      appendParagraphLine(line, start, end);
      fence = openingFence;
      continue;
    }

    const chapterHeading = atxHeadingTitle(line, 2);
    if (chapterHeading !== null) {
      flushParagraph();
      pendingChapterTitle = sliceUnicodeScalarPrefix(chapterHeading, MAX_STORY_TITLE_CHARS);
      continue;
    }

    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }

    appendParagraphLine(line, start, end);
  }

  flushParagraph();

  if (pendingChapterTitle !== null && parts.length > 0) {
    const prevIndex = parts.length - 1;
    appendChapterBreak(prevIndex, pendingChapterTitle);
    pendingChapterTitle = null;
  }

  if (!titleFound) {
    const fallback = defaultTitle?.trim() || "Imported story";
    title = sliceUnicodeScalarPrefix(fallback, MAX_STORY_TITLE_CHARS);
  }
  consumeManifestBytes(Buffer.byteLength(JSON.stringify(title)));

  if (parts.length === 0 && !titleFound) {
    throw new ServiceError(400, "No importable prose found in Markdown file");
  }

  return {
    title,
    parts,
    chapterBreaks
  };

  function appendParagraphLine(line: string, start: number, end: number): void {
    if (paragraphStart === -1) {
      paragraphStart = start;
      paragraphNormalizedChars = line.length;
    } else {
      paragraphNormalizedChars += 1 + line.length;
    }
    paragraphEnd = end;
    if (paragraphNormalizedChars > remainingChars) {
      throw new ServiceError(400, "Markdown expands to more text than can be imported");
    }
  }

  function decodeStoryTitleMarker(line: string): string | undefined {
    try {
      return decodeMarkdownStoryTitleMarker(line);
    } catch (error) {
      throw new ServiceError(400, error instanceof Error ? error.message : "Invalid 1667 Markdown title marker");
    }
  }

  function decodeChapterMarker(line: string): ReturnType<typeof decodeMarkdownChapterMarker> {
    try {
      return decodeMarkdownChapterMarker(line);
    } catch (error) {
      throw new ServiceError(400, error instanceof Error ? error.message : "Invalid 1667 Markdown chapter marker");
    }
  }
}

function atxHeadingTitle(line: string, level: 1 | 2): string | null {
  let cursor = 0;
  while (cursor < line.length && line[cursor] === " " && cursor < 4) cursor += 1;
  if (cursor > 3) return null;
  for (let index = 0; index < level; index += 1) {
    if (line[cursor + index] !== "#") return null;
  }
  cursor += level;
  if (line[cursor] === "#") return null;
  if (cursor === line.length) return "";
  if (line[cursor] !== " " && line[cursor] !== "\t") return null;
  return line.slice(cursor + 1).trim();
}

function markdownFence(line: string): MarkdownFence | null {
  let cursor = 0;
  while (cursor < line.length && line[cursor] === " " && cursor < 4) cursor += 1;
  if (cursor > 3) return null;
  const marker = line[cursor];
  if (marker !== "`" && marker !== "~") return null;
  let end = cursor;
  while (line[end] === marker) end += 1;
  if (end - cursor < 3) return null;
  if (marker === "`" && line.slice(end).includes("`")) return null;
  return { marker, length: end - cursor };
}

function isClosingFence(line: string, fence: MarkdownFence): boolean {
  let cursor = 0;
  while (cursor < line.length && line[cursor] === " " && cursor < 4) cursor += 1;
  if (cursor > 3 || line[cursor] !== fence.marker) return false;
  let end = cursor;
  while (line[end] === fence.marker) end += 1;
  return end - cursor >= fence.length && line.slice(end).trim().length === 0;
}

function isGeneratedDerivedComment(line: string): boolean {
  const prefix = "<!-- derived from \"";
  const storySeparator = "\" (story ";
  const nodeSeparator = ", node ";
  const suffix = ") -->";
  if (!line.startsWith(prefix) || !line.endsWith(suffix)) return false;
  const storyAt = line.lastIndexOf(storySeparator);
  const nodeAt = line.lastIndexOf(nodeSeparator);
  return storyAt >= prefix.length
    && nodeAt > storyAt + storySeparator.length
    && nodeAt + nodeSeparator.length < line.length - suffix.length;
}

/** Iterate a bounded input yielding line content and character offsets. */
function* iterateLineInfos(text: string): Generator<LineInfo> {
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const lineEnd = end > start && text[end - 1] === "\r" ? end - 1 : end;
    yield { line: text.slice(start, lineEnd), start, end: lineEnd };
    if (newline === -1) return;
    start = newline + 1;
  }
}
