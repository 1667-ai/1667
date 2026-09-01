import {
  authorsNoteWarning,
  MAX_AUTHORS_NOTE_CHARS,
  MAX_AUTHORS_NOTE_DEPTH
} from "../../../../shared/authors-note.js";
import { unicodeScalarLength } from "../../../../shared/unicode.js";
import { composerPosition } from "../../composer-model.js";
import type { HitTarget } from "../../hit.js";
import type { DocumentEditorSession } from "../../state.js";
import {
  FACTS_BUDGET_STATUS,
  factsBudgetFooterActions,
  type FactsBudgetEditor
} from "../../facts-budget-editor.js";
import {
  renderComposerInput,
  renderComposerLayout,
  type ComposerLayout
} from "./composer.js";
import {
  composerFieldLine,
  type ComposerStatus as ComposerChromeStatus
} from "./composer-chrome.js";
import {
  segment,
  visibleWidth,
  type FrameLine
} from "./frame.js";

export function editorFooterHints(editor: DocumentEditorSession): string {
  if (editor.kind === "document"
    && editor.target.kind === "settings-prompt") {
    return "shift+arrows select · ctrl+c/x/v · ctrl+s keep draft · esc cancel";
  }
  // Part editors offer dual save; other targets and incomplete fixtures keep
  // the single-save footer (tests may stub a minimal session without target).
  if (editor.kind === "document" && editor.target.kind === "part") {
    // ctrl+o is the portable same-take chord; ctrl+shift+s is an alias where
    // the terminal reports modified keys.
    return "shift+arrows select · ctrl+c/x/v · ctrl+s new take · ctrl+o same take · esc cancel";
  }
  return "shift+arrows select · ctrl+c/x/v · ctrl+s save · esc cancel";
}

/** Facts Budget is a bounded scalar, so keep its editor to one Settings-style
 * field instead of opening the multiline document surface. The shared
 * composer renderer still owns caret, selection, clipping, and history. */
export function renderFactsBudgetLayout(
  editor: FactsBudgetEditor,
  width: number,
  height: number,
  footerNotice: string | null
): ComposerLayout {
  const layout = renderComposerLayout({
    composer: editor.composer,
    fullscreen: false,
    terminalWidth: width,
    terminalHeight: height,
    measure: width,
    composeMaxHeight: 1,
    title: editor.title,
    status: { text: FACTS_BUDGET_STATUS },
    footerActions: factsBudgetFooterActions(width),
    placeholder: "uncapped",
    footerNotice,
    narrow: width < 100,
    softWrap: false,
    caret: "focused"
  });
  const body = layout.lines[1];
  if (body === undefined) return layout;

  const position = composerPosition(editor.composer);
  const prefix = "┃ › facts budget ";
  const suffix = " tokens";
  // Keep the input chip at the same compact width as a Settings scalar. The
  // shared input renderer clips long drafts and keeps the caret visible.
  const chipWidth = Math.min(
    13,
    Math.max(3, layout.fieldWidth - visibleWidth(prefix) - visibleWidth(suffix))
  );
  const input = renderComposerInput(
    editor.composer,
    position.line,
    position.column,
    Math.max(1, chipWidth - 2),
    "focused",
    editor.composer.text.length === 0,
    "uncapped"
  );
  layout.lines[1] = composerFieldLine("", layout.fieldWidth, [
    segment("┃ ", "compose accent"),
    segment("› ", "compose accent"),
    segment("facts budget ", "prose"),
    segment("[", "chrome"),
    ...input,
    segment("]", "chrome"),
    segment(" tokens", "chrome")
  ]);
  return layout;
}

export function composerHitTarget(line: FrameLine | undefined): HitTarget {
  const sources = new Map<string, boolean>();
  for (const part of line ?? []) {
    if (part.composerHitSource !== undefined) {
      sources.set(part.composerHitSource.id, part.composerHitSource.editable);
    }
  }
  if (sources.size !== 1) return { kind: "composer" };
  const source = sources.entries().next().value;
  if (source === undefined) return { kind: "composer" };
  return {
    kind: "composer",
    composerSourceId: source[0],
    composerEditable: source[1]
  };
}

export function authorNoteStatus(
  host: DocumentEditorSession,
  width: number
): ComposerChromeStatus | undefined {
  if (host.kind !== "document" || host.target.kind !== "authors-note") return undefined;
  const maxWidth = Math.max(1, width - visibleWidth(`┏━ ${host.title} `) - 1);
  if (unicodeScalarLength(host.composer.text, MAX_AUTHORS_NOTE_CHARS) > MAX_AUTHORS_NOTE_CHARS) {
    const text = [
      `· max is ${MAX_AUTHORS_NOTE_CHARS.toLocaleString("en-US")} Unicode scalar values`,
      `· max is ${MAX_AUTHORS_NOTE_CHARS.toLocaleString("en-US")} scalar values`,
      `· max is ${MAX_AUTHORS_NOTE_CHARS.toLocaleString("en-US")}`
    ].find((candidate) => [...candidate].length <= maxWidth)
      ?? `· max is ${MAX_AUTHORS_NOTE_CHARS.toLocaleString("en-US")}`;
    return { text, role: "danger text" };
  }
  const warning = authorsNoteWarning(host.composer.text, maxWidth);
  if (warning !== null) return { text: warning, role: "context warning" };
  const depthShort = `depth ${host.target.depth}/${MAX_AUTHORS_NOTE_DEPTH}`;
  const depthHint = `${depthShort} · ⌥-/= change`;
  const text = [depthHint, depthShort].find((candidate) => [...candidate].length <= maxWidth) ?? depthShort;
  return { text, role: "context note" };
}
