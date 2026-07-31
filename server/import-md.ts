import { ServiceError } from "./errors.js";
import { sliceWellFormedUtf16Prefix } from "../shared/unicode.js";
import { MAX_STORY_TITLE_CHARS } from "./story-v5-strict.js";
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

export function partsFromMarkdown(markdown: string, defaultTitle?: string): MarkdownImport {
  if (Buffer.byteLength(markdown) > MAX_IMPORT_BYTES) {
    throw new ServiceError(413, "Request body too large");
  }

  let title = "";
  let titleFound = false;
  const parts: ImportedPart[] = [];
  const chapterBreaks: MarkdownImportBreak[] = [];
  let remainingChars = MAX_TOTAL_CHARS;
  let paragraphStart = -1;
  let paragraphEnd = -1;
  let paragraphNormalizedChars = 0;
  let pendingChapterTitle: string | null = null;

  const flushParagraph = () => {
    if (paragraphStart === -1) return;
    const rawText = textWithoutComments.slice(paragraphStart, paragraphEnd);
    paragraphStart = -1;
    paragraphEnd = -1;
    paragraphNormalizedChars = 0;
    const text = rawText.replace(/\r\n/g, "\n").trim();
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

    const newPartIndex = parts.length - 1;

    if (pendingChapterTitle !== null && newPartIndex > 0) {
      const prevIndex = newPartIndex - 1;
      if (!chapterBreaks.some((b) => b.parentPartIndex === prevIndex)) {
        chapterBreaks.push({
          parentPartIndex: prevIndex,
          title: pendingChapterTitle
        });
      }
      pendingChapterTitle = null;
    } else {
      pendingChapterTitle = null;
    }
  };

  let beforeProse = true;
  const textWithoutComments = markdown.replace(/<!--[\s\S]*?-->/g, "");
  for (const { line, start, end } of iterateLineInfos(textWithoutComments)) {
    const trimmed = line.trim();

    if (beforeProse && trimmed.length === 0) continue;
    if (beforeProse) {
      beforeProse = false;
      if (trimmed.startsWith("# ")) {
        const candidateTitle = trimmed.slice(2).trim();
        if (candidateTitle.length > 0) {
          title = sliceWellFormedUtf16Prefix(candidateTitle, MAX_STORY_TITLE_CHARS);
          titleFound = true;
        }
        continue;
      }
    }

    if (trimmed.startsWith("## ")) {
      flushParagraph();
      const headingTitle = trimmed.slice(3).trim();
      pendingChapterTitle = sliceWellFormedUtf16Prefix(headingTitle, MAX_STORY_TITLE_CHARS);
      continue;
    }

    if (trimmed.startsWith("##") && !trimmed.startsWith("###")) {
      flushParagraph();
      const headingTitle = trimmed.slice(2).trim();
      pendingChapterTitle = sliceWellFormedUtf16Prefix(headingTitle, MAX_STORY_TITLE_CHARS);
      continue;
    }

    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }

    if (paragraphStart === -1) {
      paragraphStart = start;
      paragraphNormalizedChars = line.trimStart().length;
    } else {
      paragraphNormalizedChars += 1 + line.length;
    }
    paragraphEnd = end;
    const charsAfterFinalTrim = paragraphNormalizedChars
      - (line.length - line.trimEnd().length);
    if (charsAfterFinalTrim > remainingChars) {
      throw new ServiceError(400, "Markdown expands to more text than can be imported");
    }
  }

  flushParagraph();

  if (pendingChapterTitle !== null && parts.length > 0) {
    const prevIndex = parts.length - 1;
    if (!chapterBreaks.some((b) => b.parentPartIndex === prevIndex)) {
      chapterBreaks.push({
        parentPartIndex: prevIndex,
        title: pendingChapterTitle
      });
    }
    pendingChapterTitle = null;
  }

  if (!titleFound) {
    const fallback = defaultTitle?.trim() || "Imported story";
    title = sliceWellFormedUtf16Prefix(fallback, MAX_STORY_TITLE_CHARS);
  }

  if (parts.length === 0) {
    throw new ServiceError(400, "No importable prose found in Markdown file");
  }

  return {
    title,
    parts,
    chapterBreaks
  };
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
