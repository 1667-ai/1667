/**
 * Fact header grammar for the inline editor. One owner for tag cycle, custom
 * tag entry, one-line tag transforms, save validation, and editor chrome so
 * the generic editor reducer and renderer stay target-agnostic.
 */
import {
  insertComposerText,
  replaceComposerTextRange,
  type ComposerState
} from "./composer-model.js";
import { graphemeCells } from "./cell-width.js";
import {
  factEditorSelectionInsideTag,
  factEditorTag,
  factEditorTagLineRange,
  factEditorTagRange,
  factTagPresets,
  parseFactEditor,
  serializeFactTagHeader
} from "./facts-model.js";
import type { ResolvedKey } from "./keys.js";
import type { InlineEditorSession, RuntimeState } from "./state.js";

const FACT_EDITOR_FOOTER =
  "tab/shift+tab tag · ctrl+t custom · ctrl+s save · esc cancel";
/** Blank separator after a newly inserted Fact tag header line. */
const FACT_HEADER_SEPARATOR = "\n\n";

/** Fact-only editor commands. Returns true when the action is fully handled. */
export function handleFactEditorCommand(
  resolved: ResolvedKey,
  state: RuntimeState,
  editor: InlineEditorSession
): boolean {
  if (resolved.action === "cycle") {
    cycleFactEditorTag(state, editor, resolved.index === -1 ? -1 : 1);
    return true;
  }
  if (resolved.action === "edit-tag") {
    selectFactEditorTag(state, editor);
    return true;
  }
  return false;
}

/**
 * Title and footer for the Fact inline editor. Owns tag display grammar so
 * the story renderer does not parse Fact headers.
 */
export function factEditorChrome(
  baseTitle: string,
  composerText: string
): { title: string; footerHints: string } {
  const tagLabel = factEditorTagLabel(composerText);
  return {
    title: `${baseTitle} · tag ‹ ${tagLabel} ›`,
    footerHints: FACT_EDITOR_FOOTER
  };
}

/** One-line tag label for chrome: multiline tags collapse to ↵ markers. */
export function factEditorTagLabel(composerText: string): string {
  return factEditorTag(composerText)?.replace(/[\r\n\u2028\u2029]+/gu, "↵") ?? "none";
}

/** Tab / Shift+Tab: walk StoryTavern presets plus saved custom tags. */
export function cycleFactEditorTag(
  state: RuntimeState,
  editor: InlineEditorSession,
  direction: -1 | 1
): void {
  const current = factEditorTag(editor.composer.text);
  const options = factTagPresets(state.payload.facts, current);
  const at = Math.max(0, options.indexOf(current));
  replaceFactEditorTag(
    editor,
    options[(at + direction + options.length) % options.length] ?? null
  );
}

/** Ctrl+T: select the tag field for custom entry. When the document uses a
 *  structured tag-json header, rewrite it to a plain `tag:` line first and
 *  record the tag selection as the redo caret (not the body caret). */
export function selectFactEditorTag(
  state: RuntimeState,
  editor: InlineEditorSession
): void {
  const range = factEditorTagRange(editor.composer.text);
  if (range === null) {
    insertMissingFactTagHeader(editor, null, "select-tag");
    state.toast = "type a custom tag · saved tags join this slider";
    return;
  }
  if (/^tag-json:/i.test(editor.composer.text)) {
    replaceFactEditorTag(editor, null, "select-tag");
    state.toast = "type a custom tag · saved tags join this slider";
    return;
  }
  editor.composer.anchor = range.start;
  editor.composer.cursor = range.end;
  state.toast = "type a custom tag · saved tags join this slider";
}

/**
 * Insert text for a Fact editor surface. Keeps tags on one line: newlines in
 * the tag field become spaces (paste/input) or a blocked toast (bare newline).
 * Body inserts pass through unchanged.
 */
export function factEditorInsert(
  composer: ComposerState,
  raw: string,
  source: "paste" | "input" | "newline"
): { text: string } | { blocked: string } {
  if (!factEditorSelectionInsideTag(composer.text, composer.cursor, composer.anchor)) {
    return { text: raw };
  }
  if (source === "newline" || /^[\r\n\u2028\u2029]+$/u.test(raw)) {
    return { blocked: "fact tags stay on one line" };
  }
  if (/[\r\n\u2028\u2029]/u.test(raw)) {
    return { text: raw.replace(/[\r\n\u2028\u2029]+/gu, " ") };
  }
  return { text: raw };
}

/**
 * One paste-admission owner for native paste and clipboard Ctrl+V. Owns Fact
 * transform, blocked toast, confirmation disarm, and insertion. Returns false
 * only when there is no insertable text (callers set empty-clipboard toast).
 */
export function admitEditorPaste(
  state: { toast?: string | null },
  editor: InlineEditorSession,
  clean: string
): boolean {
  if (clean.length === 0) return false;
  if (editor.conflict !== null) editor.conflict.armed = false;
  editor.cutConfirmation = null;
  const insert = editor.target.kind === "fact"
    ? factEditorInsert(editor.composer, clean, "paste")
    : { text: clean };
  if ("blocked" in insert) {
    state.toast = insert.blocked;
    return true;
  }
  insertComposerText(editor.composer, insert.text);
  return true;
}

/** Validate a Fact document before save. */
export function factEditorSavePayload(
  submitted: string
): { ok: true; tag: string | null; text: string } | { ok: false; toast: string } {
  const parsed = parseFactEditor(submitted);
  if (parsed === null) {
    return { ok: false, toast: "invalid tag-json · fix it or use tag: to clear" };
  }
  if (parsed.text.trim().length === 0) {
    return { ok: false, toast: "fact text cannot be empty" };
  }
  return { ok: true, tag: parsed.tag, text: parsed.text };
}

function replaceFactEditorTag(
  editor: InlineEditorSession,
  tag: string | null,
  caretMode: "body" | "select-tag" = "body"
): void {
  if (editor.conflict !== null) editor.conflict.armed = false;
  editor.cutConfirmation = null;

  const range = factEditorTagLineRange(editor.composer.text);
  if (range === null) {
    insertMissingFactTagHeader(editor, tag, caretMode);
    return;
  }

  const cursor = editor.composer.cursor;
  const anchor = editor.composer.anchor;
  const header = serializeFactTagHeader(tag);
  const after = { start: range.start, end: range.start + graphemeCells(header).length };

  if (caretMode === "select-tag") {
    // Final history state is the tag field selection so redo leaves typing in
    // the custom tag, not the body.
    replaceComposerTextRange(editor.composer, range.start, range.end, header, {
      ...tagFieldCaret(header)
    });
    return;
  }

  // Translate the body caret before the replace so cycle redo restores it.
  const nextCursor = translateOffset(cursor, range, after);
  const nextAnchor = translateOffset(anchor, range, after);
  replaceComposerTextRange(
    editor.composer,
    range.start,
    range.end,
    header,
    {
      cursor: nextCursor ?? after.end,
      anchor: nextAnchor
    }
  );
}

/**
 * Insert a missing tag header as a recorded range replace so undo restores the
 * headerless document (and prior body edits) and redo restores the command.
 */
function insertMissingFactTagHeader(
  editor: InlineEditorSession,
  tag: string | null,
  caretMode: "body" | "select-tag"
): void {
  const header = serializeFactTagHeader(tag);
  const inserted = `${header}${FACT_HEADER_SEPARATOR}`;
  const shift = graphemeCells(inserted).length;
  if (caretMode === "select-tag") {
    replaceComposerTextRange(editor.composer, 0, 0, inserted, tagFieldCaret(header));
    return;
  }
  const cursor = editor.composer.cursor;
  const anchor = editor.composer.anchor;
  replaceComposerTextRange(editor.composer, 0, 0, inserted, {
    cursor: cursor + shift,
    anchor: anchor === null ? null : anchor + shift
  });
}

function tagFieldCaret(header: string): { cursor: number; anchor: number } {
  const prefix = /^(tag(?:-json)?:\s*)/i.exec(header)?.[1] ?? "tag: ";
  return {
    cursor: graphemeCells(header).length,
    anchor: graphemeCells(prefix).length
  };
}

function translateOffset(
  offset: number | null,
  before: { start: number; end: number },
  after: { start: number; end: number }
): number | null {
  if (offset === null) return null;
  if (offset <= before.start) return offset;
  if (offset >= before.end) return after.end + offset - before.end;
  return after.start + Math.min(offset - before.start, after.end - after.start);
}
