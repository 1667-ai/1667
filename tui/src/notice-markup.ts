import type { StyleRun } from "./wrap.js";

/** The two inline spans CHANGELOG.md entries actually use. Nothing else in
 *  markdown gets a style here — an unmatched or unsupported marker survives
 *  as literal text instead (see `scanInline`). */
export type NoticeMarkupStyle = "bold" | "code";

export interface NoticeMarkup {
  readonly text: string;
  readonly runs: readonly StyleRun<NoticeMarkupStyle>[];
}

/**
 * Parse the markdown subset CHANGELOG.md entries use — `**bold**`,
 * `` `code` ``, `- ` list items, and a blank line as a paragraph break —
 * into text `wrapText` (wrap.ts) can wrap and style runs a renderer can turn
 * into segments. Everything else in markdown is left alone: an unmatched
 * marker (a lone `*`, an unclosed backtick) renders as the literal
 * character rather than disappearing.
 *
 * Pure: markdown text in, `{text, runs}` out. `text` still carries `\n`
 * structure — a block boundary is `\n` where the source ran two lines
 * together with no blank line between them, `\n\n` where the source had
 * one. `noticeMarkupBlocks` reads that same structure back, so a caller
 * that already has `text` never needs to re-parse the original markdown to
 * find it.
 *
 * A list item's `- ` marker survives into `text` as two literal characters
 * (not a run) — it costs nothing to wrap alongside the rest of the item,
 * and it is what lets `noticeMarkupBlocks` tell a list item from a plain
 * paragraph without extra state passed alongside `text`.
 */
export function parseNoticeMarkup(source: string): NoticeMarkup {
  const blocks = splitBlocks(source);
  let text = "";
  const runs: StyleRun<NoticeMarkupStyle>[] = [];
  blocks.forEach((block, index) => {
    if (index > 0) text += block.blankBefore ? "\n\n" : "\n";
    const prefix = block.list ? "- " : "";
    const scanned = scanInline(block.source);
    const offset = text.length + prefix.length;
    for (const run of scanned.runs) {
      runs.push({ start: run.start + offset, end: run.end + offset, style: run.style });
    }
    text += prefix + scanned.text;
  });
  return { text, runs };
}

/** One paragraph or list item in text `parseNoticeMarkup` produced, as an
 *  offset range into that text — the same paragraph boundaries `wrapText`
 *  finds on the same text, so a `WrappedLine`'s `start` always falls inside
 *  exactly one of these. A block never holds an internal newline. */
export interface NoticeMarkupBlock {
  readonly start: number;
  readonly end: number;
  readonly list: boolean;
}

/** Read the block structure back out of `parseNoticeMarkup`'s own output,
 *  rather than threading it through as extra return state: the cleaned text
 *  already carries it, a `\n` split away. Mirrors `wrapText`'s own
 *  paragraph-boundary loop exactly, so the two never disagree about where a
 *  paragraph starts or ends. */
export function noticeMarkupBlocks(text: string): readonly NoticeMarkupBlock[] {
  const blocks: NoticeMarkupBlock[] = [];
  let paragraphStart = 0;
  while (paragraphStart <= text.length) {
    const newline = text.indexOf("\n", paragraphStart);
    const paragraphEnd = newline === -1 ? text.length : newline;
    blocks.push({
      start: paragraphStart,
      end: paragraphEnd,
      list: text.slice(paragraphStart, paragraphEnd).startsWith("- ")
    });
    if (newline === -1) break;
    paragraphStart = newline + 1;
  }
  return blocks;
}

interface RawBlock {
  /** Already joined to one line and whitespace-collapsed; markers intact. */
  readonly source: string;
  readonly list: boolean;
  /** Whether a blank source line preceded this block — `parseNoticeMarkup`
   *  turns that into a `\n\n` paragraph break, and its absence into a tight
   *  `\n`, so two list items the source ran together stay run together. */
  readonly blankBefore: boolean;
}

/** Group raw markdown lines into paragraphs and list items. A `- ` line
 *  always starts a new block, blank line before it or not — that is what
 *  keeps consecutive list items visually distinct even when the source
 *  never put a blank line between them. Any other line joins whatever block
 *  is open, or opens a new paragraph if none is. */
function splitBlocks(source: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let currentLines: string[] | null = null;
  let currentList = false;
  let currentBlankBefore = false;
  let pendingBlank = false;

  const flush = () => {
    if (currentLines === null) return;
    blocks.push({
      source: currentLines.join(" ").replace(/\s+/gu, " ").trim(),
      list: currentList,
      blankBefore: currentBlankBefore
    });
    currentLines = null;
  };

  for (const rawLine of source.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      flush();
      pendingBlank = true;
      continue;
    }
    if (trimmed.startsWith("- ")) {
      flush();
      currentLines = [trimmed.slice(2).trimStart()];
      currentList = true;
      currentBlankBefore = pendingBlank;
      pendingBlank = false;
      continue;
    }
    if (currentLines === null) {
      currentLines = [trimmed];
      currentList = false;
      currentBlankBefore = pendingBlank;
      pendingBlank = false;
    } else {
      currentLines.push(trimmed);
    }
  }
  flush();
  return blocks;
}

/** Strip `**bold**` and `` `code` `` markers from one block's already-flat
 *  source, left to right, recording where each stripped span landed in the
 *  output. A marker with no match — a lone `*`, an unclosed backtick — is
 *  never consumed specially: the loop falls through and copies it one
 *  character at a time, so the text it introduces survives untouched. */
function scanInline(source: string): { text: string; runs: StyleRun<NoticeMarkupStyle>[] } {
  let text = "";
  const runs: StyleRun<NoticeMarkupStyle>[] = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("**", index)) {
      const close = source.indexOf("**", index + 2);
      if (close !== -1) {
        const start = text.length;
        text += source.slice(index + 2, close);
        runs.push({ start, end: text.length, style: "bold" });
        index = close + 2;
        continue;
      }
    } else if (source[index] === "`") {
      const close = source.indexOf("`", index + 1);
      if (close !== -1) {
        const start = text.length;
        text += source.slice(index + 1, close);
        runs.push({ start, end: text.length, style: "code" });
        index = close + 1;
        continue;
      }
    }
    text += source[index];
    index += 1;
  }
  return { text, runs };
}
