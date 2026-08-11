import type { HitRows, HitTarget } from "../hit.js";
import { wrapText } from "../wrap.js";
import { addInlineHits } from "./story/hits.js";
import { fitLine, segment, visibleWidth, type FrameLine } from "./story/frame.js";

/** One row of a request document body: a line plus the hit target that owns
 *  its full width, or `null` for rows nothing can select. */
export interface RequestDocumentRow {
  line: FrameLine;
  target: HitTarget | null;
}

/** The document's own top rule — one heavy line naming the whole page. */
export function titleRule(title: string, width: number): FrameLine {
  const prefix = `━━ ${title} `;
  return [
    segment(prefix, "focus / accent"),
    segment("━".repeat(Math.max(0, width - visibleWidth(prefix))), "chrome")
  ];
}

/** A rule inside the body naming one section of it — lighter than
 *  `titleRule` so a reader can tell a section from the document itself. */
export function sectionRule(text: string, width: number): FrameLine {
  const prefix = `── ${text} `;
  return [
    segment(prefix, "focus / accent"),
    segment("─".repeat(Math.max(0, width - visibleWidth(prefix))), "chrome")
  ];
}

/** A labelled block of wrapped notice prose, fenced by a full-width divider
 *  above and a blank row below. Returns no rows for an empty notice list, so
 *  callers can push the result unconditionally. */
export function noticeSection(label: string, notices: string[], width: number): RequestDocumentRow[] {
  if (notices.length === 0) return [];
  const rows: RequestDocumentRow[] = [
    { line: [segment("─".repeat(Math.max(0, width)), "chrome")], target: null },
    { line: [segment(` ${label}`, "focus / accent")], target: null }
  ];
  for (const notice of notices) {
    rows.push(...wrapText(notice, [], Math.max(1, width - 3)).map(({ text }): RequestDocumentRow => ({
      line: [segment("  ", "chrome"), segment(text, "focus / accent")],
      target: null
    })));
  }
  rows.push({ line: [], target: null });
  return rows;
}

/** One message's rows: a full-width divider, the caller's own header line,
 *  any caller-supplied rows between the header and the content (an image
 *  block's metadata, which carries no text to wrap — see
 *  tui/src/screens/request-viewer.ts), the wrapped message content, and a
 *  trailing blank row. Knows nothing of `NextRequestEstimate` or its plan —
 *  the caller builds the header (role, category, token count, selection
 *  styling) and hands it over already built, so this stays reusable for any
 *  document of message-shaped rows. */
export function messageDocumentRows(
  target: HitTarget,
  header: FrameLine,
  content: string,
  width: number,
  extraRows: readonly RequestDocumentRow[] = []
): RequestDocumentRow[] {
  const rows: RequestDocumentRow[] = [
    { line: [segment("─".repeat(Math.max(0, width)), "chrome", target)], target },
    { line: header, target },
    ...extraRows
  ];
  for (const wrapped of wrapText(content, [], Math.max(1, width - 4))) {
    rows.push({ line: [segment("  ", "chrome"), segment(wrapped.text, "prose")], target: null });
  }
  rows.push({ line: [], target: null });
  return rows;
}

export interface RequestDocumentShellInput {
  header: FrameLine[];
  body: RequestDocumentRow[];
  footer: FrameLine[];
  width: number;
  height: number;
  /** The document's own stored scroll offset. Negative means "reveal the
   *  focused row", the convention `RequestViewerState.scrollTop` uses. */
  scrollTop: number;
  /** The body row where the focused row starts, for the reveal case. */
  reveal: number;
  /** The focused row is the first one, so a reveal scrolls to the top. */
  revealAtStart: boolean;
}

export interface RequestDocumentShell {
  lines: FrameLine[];
  hitRows: HitRows;
  scrollTop: number;
}

/** The full-screen document shell shared by every request-style viewer:
 *  clips header/body/footer to the frame, resolves the scroll offset
 *  (revealing the focused row on request, otherwise honouring the caller's
 *  own scroll), pads the body to fill the frame, fits every line to width,
 *  and wires the footer's own breadcrumb keys as clickable hits. */
export function renderRequestDocumentShell(input: RequestDocumentShellInput): RequestDocumentShell {
  const { header, body, footer, width, height } = input;
  const bodyHeight = Math.max(0, height - header.length - footer.length);
  const maxScroll = Math.max(0, body.length - bodyHeight);
  const requestedScroll = input.scrollTop < 0
    ? input.revealAtStart ? 0 : Math.max(0, Math.min(maxScroll, input.reveal - 1))
    : input.scrollTop;
  const scrollTop = Math.max(0, Math.min(maxScroll, requestedScroll));
  const visible = body.slice(scrollTop, scrollTop + bodyHeight);
  const padded: RequestDocumentRow[] = [
    ...visible,
    ...Array.from({ length: Math.max(0, bodyHeight - visible.length) }, (): RequestDocumentRow => ({
      line: [], target: null
    }))
  ];
  const rows = [
    ...header.map((line): RequestDocumentRow => ({ line, target: null })),
    ...padded,
    ...footer.map((line): RequestDocumentRow => ({ line, target: null }))
  ].slice(0, height);
  const lines = rows.map(({ line }) => fitLine(line, width));
  const hitRows: HitRows = rows.map(({ target }) => target === null
    ? null
    : { target, left: 0, right: width });
  // The breadcrumb's keys carry their actions on their own segments, the way
  // the map's and search's do; without this they are painted text.
  const breadcrumb = lines.length - 1;
  if (lines[breadcrumb] !== undefined) {
    addInlineHits([lines[breadcrumb]!], hitRows, () => true, breadcrumb);
  }
  return { lines, hitRows, scrollTop };
}
