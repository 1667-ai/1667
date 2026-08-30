import type { KeyAction } from "../../keys.js";
import { wrapFeedback } from "../feedback-wrap.js";
import {
  fitLine,
  hintItem,
  joinHints,
  segment,
  visibleWidth,
  type FrameLine,
  type FrameSegment,
  type HintItem,
  type DisplayRole
} from "./frame.js";

/** How much of the composer a notice may take before the draft loses room.
 *  Decision 24's cap for a result line. */
const MAX_NOTICE_ROWS = 3;
/** `!` is a character in COMPOSE, so the route to the log names the two keys
 *  it actually takes from here. */
const NOTICE_OVERFLOW = "esc then ! for all of it";

export interface ComposerStatus {
  text: string;
  role?: DisplayRole;
}

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
  status?: ComposerStatus
): FrameLine {
  const prefix = `┏━ ${title} `;
  const suffix = status?.text.length ? ` ${status.text}` : "";
  const rule = "━".repeat(
    Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix))
  );
  return composerFieldLine(indent, width, [
    segment(prefix, "compose accent"),
    segment(rule, "compose accent"),
    ...(suffix.length > 0 ? [segment(suffix, status?.role ?? "chrome")] : [])
  ]);
}

/** Which prompt session, if any, owns the composer — drives the send/escape
 *  wording. `null` is the persistent Direct composer. */
export type ComposerPromptKind = "retake" | "rewrite" | null;

export function renderComposerFooter(
  indent: string,
  width: number,
  fullscreen: boolean,
  narrow: boolean,
  notice: string | null,
  override?: string,
  promptKind: ComposerPromptKind = null,
  footerActions?: readonly HintItem[]
): FrameLine[] {
  const lead = segment("┗━ ", "compose accent");
  const budget = Math.max(0, width - visibleWidth("┗━ "));
  if (notice !== null) {
    // A notice is the composer's footer, not a second panel. Provider errors
    // arrive at whatever length a provider chose, and an unbounded wrap pushes
    // the draft itself down to a single row. Decision 24's cap applies, and
    // past it the body truncates while the last row keeps the way out — here
    // that is the log, which COMPOSE reaches after `esc` because `!` is a
    // character the writer may be typing.
    const wrapped = wrapFeedback(notice, Math.max(1, budget), MAX_NOTICE_ROWS, NOTICE_OVERFLOW);
    return wrapped.rows.map((text, index) =>
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
  if (footerActions !== undefined) {
    return [composerFieldLine(indent, width, [
      lead,
      ...joinHints(footerActions, budget)
    ])];
  }
  return [composerFieldLine(indent, width, [
    lead,
    ...joinHints(composerFooterKeys(fullscreen, narrow, promptKind), budget)
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
  promptKind: ComposerPromptKind
): HintItem[] {
  const key = (token: string, action: KeyAction, rank = 0): HintItem =>
    hintItem([segment(token, "chrome", { kind: "action", action })], rank);
  const send = promptKind === "retake" ? "enter retakes with this prompt"
    : promptKind === "rewrite" ? "enter rewrites in place"
    : "enter send";
  const escape = fullscreen ? "esc inline" : promptKind !== null ? "esc cancels" : "esc nav";
  const exit = fullscreen ? "⌃f exit" : narrow ? "⌃f full" : "⌃f fullscreen";
  return [
    key(send, "send"),
    // The rewrite composer's only other destination (issue #319) — ⌃s, the
    // exact key a manual edit uses to fork a take (editor-action.ts), given
    // the opposite meaning of enter here. A separate hint item, not folded
    // into `send` above, so each half stays its own click target instead of
    // one span answering for two different actions.
    ...(promptKind === "rewrite" ? [key("⌃s as take", "send-as-take", 1)] : []),
    key("⇧enter newline", "newline", 1),
    ...(promptKind !== null && !fullscreen
      ? []
      : [key(exit, "toggle-compose-fullscreen", 2)]),
    key(escape, "cancel")
  ];
}
