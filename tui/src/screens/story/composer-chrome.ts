import type { KeyAction } from "../../keys.js";
import { wrapText } from "../../wrap.js";
import {
  fitLine,
  hintItem,
  joinHints,
  segment,
  truncate,
  visibleWidth,
  type FrameLine,
  type FrameSegment,
  type HintItem
} from "./frame.js";

/** How much of the composer a notice may take before the draft loses room. */
const MAX_NOTICE_ROWS = 3;

export function composerTitle(
  fullscreen: boolean,
  part: number | null | undefined
): string {
  const mode = fullscreen ? "compose · fullscreen" : "compose";
  return part === null || part === undefined ? mode : `${mode} · ¶ ${part}`;
}

export function renderComposerTop(
  indent: string,
  width: number,
  title: string,
  counter: string
): FrameLine {
  const prefix = `┏━ ${title} `;
  const suffix = counter.length > 0 ? ` ${counter}` : "";
  const rule = "━".repeat(
    Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix))
  );
  return composerFieldLine(indent, width, [
    segment(prefix, "compose accent"),
    segment(rule, "compose accent"),
    ...(suffix.length > 0 ? [segment(suffix, "chrome")] : [])
  ]);
}

export function renderComposerFooter(
  indent: string,
  width: number,
  fullscreen: boolean,
  narrow: boolean,
  notice: string | null,
  override?: string,
  retaking = false
): FrameLine[] {
  const lead = segment("┗━ ", "compose accent");
  const budget = Math.max(0, width - visibleWidth("┗━ "));
  if (notice !== null) {
    const wrapped = wrapText(notice, [], Math.max(1, budget));
    // A notice is the composer's footer, not a second panel. Provider errors
    // arrive at whatever length a provider chose, and an unbounded wrap pushes
    // the draft itself down to a single row. Keep the last row readable rather
    // than dropping the rows that would not fit without a mark.
    const rows = wrapped.slice(0, MAX_NOTICE_ROWS).map((line, index) =>
      index === MAX_NOTICE_ROWS - 1 && wrapped.length > MAX_NOTICE_ROWS
        ? truncate(`${line.text} …`, Math.max(1, budget))
        : line.text
    );
    return rows.map((text, index) =>
      composerFieldLine(
        indent,
        width,
        [
          index === 0 ? lead : segment("   ", "compose accent"),
          segment(text, "compose accent")
        ]
      )
    );
  }
  if (override !== undefined) {
    return [composerFieldLine(indent, width, [lead, segment(override, "chrome")])];
  }
  return [composerFieldLine(indent, width, [
    lead,
    ...joinHints(composerFooterKeys(fullscreen, narrow, retaking), budget)
  ])];
}

export function composerFieldLine(
  indent: string,
  width: number,
  contents: FrameLine
): FrameLine {
  const field = fitLine(contents, width).map((part): FrameSegment => ({
    ...part,
    role: part.role === "background" && part.background === undefined
      ? "raised"
      : part.role,
    background: part.background ?? "raised"
  }));
  return indent.length === 0
    ? field
    : [segment(indent, "background"), ...field];
}

/** The footer keeps each advertised key clickable. */
function composerFooterKeys(
  fullscreen: boolean,
  narrow: boolean,
  retaking: boolean
): HintItem[] {
  const key = (token: string, action: KeyAction, rank = 0): HintItem =>
    hintItem([segment(token, "chrome", { kind: "action", action })], rank);
  const send = retaking ? "enter retakes with this prompt" : "enter send";
  const escape = fullscreen ? "esc inline" : retaking ? "esc cancels" : "esc nav";
  const exit = fullscreen ? "⌃f exit" : narrow ? "⌃f full" : "⌃f fullscreen";
  return [
    key(send, "send"),
    key("⇧enter newline", "newline", 1),
    ...(retaking && !fullscreen
      ? []
      : [key(exit, "toggle-compose-fullscreen", 2)]),
    key(escape, "cancel")
  ];
}
