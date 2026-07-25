import type { CliRenderer } from "@opentui/core";
import { countWords } from "../../shared/story-text.js";
import { copyToClipboard, type CopyOutcome } from "./clipboard.js";
import {
  moveComposerTo,
  selectedComposerText
} from "./composer-model.js";
import {
  composerRangeFromProjection,
  storySelectionFromProjection,
  type ComposerSelectionProjection,
  type ProjectedStorySelection,
  type StorySelectionProjection
} from "./selection-projection.js";
import { createStoryViewModel, rowPart } from "./model.js";
import type { RuntimeState } from "./state.js";

export interface SelectionCopyResult {
  text: string;
  outcome: Promise<CopyOutcome>;
}

export type StoryCopyTarget =
  | { kind: "part" }
  | { kind: "line" }
  | { kind: "selection"; text: string };

type SelectionRenderer = Pick<CliRenderer, "getSelection">;

export interface NativeSelectionSnapshot {
  identity: object | null;
  text: string;
  range: { start: number; end: number } | null;
  backward: boolean;
}

export interface SelectionProjections {
  composer: ComposerSelectionProjection | null;
  story: StorySelectionProjection | null;
}

type SelectionSource = SelectionRenderer | NativeSelectionSnapshot;

export const EMPTY_NATIVE_SELECTION: NativeSelectionSnapshot = {
  identity: null,
  text: "",
  range: null,
  backward: false
};

/** Native selection objects are renderer-owned and keep changing while an
 * input waits. Copy the fields reducers need at event arrival. */
export function captureNativeSelection(renderer: SelectionRenderer): NativeSelectionSnapshot | null {
  const selection = renderer.getSelection();
  if (selection === null) return null;
  return {
    identity: selection,
    text: selection.getSelectedText(),
    range: nativeSelectionRange(selection),
    backward: selection.focus !== undefined && selection.anchor !== undefined
      && (selection.focus.y < selection.anchor.y
        || selection.focus.y === selection.anchor.y && selection.focus.x < selection.anchor.x)
  };
}

export function nativeSelectionMatches(
  renderer: SelectionRenderer,
  expected: NativeSelectionSnapshot
): boolean {
  const current = captureNativeSelection(renderer);
  return current !== null
    && current.identity === expected.identity
    && current.text === expected.text
    && current.backward === expected.backward
    && sameRange(current.range, expected.range);
}

/** Ctrl+C outside the inline editor means copy when a selection exists,
 * otherwise quit. COMPOSE consumes an empty selection so a draft cannot close
 * the process accidentally. */
export function handleMainCopyShortcut(
  selection: SelectionSource,
  state: RuntimeState,
  repaint: () => void,
  requestQuit: () => void,
  projections?: SelectionProjections
): boolean {
  if (state.mode === "EDITOR") return false;
  const copied = copyActiveSelection(selection, state, undefined, projections);
  if (copied !== null) {
    const interactionVersion = state.interactionVersion;
    void copied.outcome.then((outcome) => {
      if (state.interactionVersion !== interactionVersion) return;
      state.toast = outcome === "unavailable"
        ? "no clipboard available · selection kept"
        : `copied selection · ${countWords(copied.text).toLocaleString("en-US")} words`;
      repaint();
    });
    return true;
  }
  if (!consumesEmptyCopyShortcut(state)) requestQuit();
  return true;
}

/** Composer surfaces consume Ctrl+C even without a selection. EDITOR handles
 * the chord in its reducer; this identifies ownership before input queues. */
export function consumesEmptyCopyShortcut(
  state: Pick<RuntimeState, "mode" | "settings">
): boolean {
  return state.mode === "COMPOSE"
    || state.mode === "EDITOR"
    || state.mode === "SETTINGS" && state.settings?.edit != null;
}

/** Convert OpenTUI's painted-cell range into the same raw document selection
 * Shift+Arrow uses. Call before any editor key or paste reducer. */
export function syncMouseComposerSelection(
  selection: SelectionSource,
  state: RuntimeState,
  projection = state.composerSelectionProjection
): boolean {
  const composer = activeComposer(state);
  if (composer === null || projection === null) return false;
  const native = readNativeSelection(selection);
  if (native === null || native.text.length === 0 || native.range === null) return false;
  const range = composerRangeFromProjection(projection, native.range.start, native.range.end);
  if (range === null) return false;
  moveComposerTo(composer, native.backward ? range.end : range.start);
  moveComposerTo(composer, native.backward ? range.start : range.end, true);
  return true;
}

/** One copy path for mouse and Shift+Arrow selections. A mouse range wins only
 * when it projects into the active editor; stale page highlights never do. */
export function copyActiveSelection(
  selection: SelectionSource,
  state: RuntimeState,
  copy: (text: string) => Promise<CopyOutcome> = copyToClipboard,
  projections: SelectionProjections = {
    composer: state.composerSelectionProjection,
    story: state.storySelectionProjection
  }
): SelectionCopyResult | null {
  const native = readNativeSelection(selection);
  const rendered = native?.text ?? "";
  const composer = activeComposer(state);
  if (composer !== null && rendered.length > 0 && native !== null) {
    syncMouseComposerSelection(native, state, projections.composer);
  }
  const draft = composer === null ? null : selectedComposerText(composer);
  const story = composer === null
    ? storyTextFromRendererSelection(native ?? EMPTY_NATIVE_SELECTION, projections.story)
    : null;
  const text = composer !== null
    ? draft ?? ""
    : story ?? rendered;
  if (text.length === 0) return null;
  return { text, outcome: copy(text) };
}

export function storyTextFromRendererSelection(
  selection: SelectionSource,
  projection: StorySelectionProjection | null
): string | null {
  return storySelectionFromRendererSelection(selection, projection)?.text ?? null;
}

export function storySelectionFromRendererSelection(
  selection: SelectionSource,
  projection: StorySelectionProjection | null
): ProjectedStorySelection | null {
  if (projection === null) return null;
  const native = readNativeSelection(selection);
  if (native === null || native.text.length === 0 || native.range === null) return null;
  return storySelectionFromProjection(projection, native.range.start, native.range.end);
}

function readNativeSelection(selection: SelectionSource): NativeSelectionSnapshot | null {
  return "getSelection" in selection ? captureNativeSelection(selection) : selection;
}

function nativeSelectionRange(
  selection: NonNullable<ReturnType<SelectionRenderer["getSelection"]>>
): { start: number; end: number } | null {
  return (selection.selectedRenderables ?? [])
    .map((renderable) => {
      const reader = renderable as unknown as {
        getSelection?: () => { start: number; end: number } | null;
      };
      return reader.getSelection?.() ?? null;
    })
    .find((range) => range !== null) ?? null;
}

function sameRange(
  left: NativeSelectionSnapshot["range"],
  right: NativeSelectionSnapshot["range"]
): boolean {
  return left === right || left !== null && right !== null
    && left.start === right.start && left.end === right.end;
}

function activeComposer(state: RuntimeState) {
  return state.mode === "EDITOR"
    ? state.editor?.composer ?? null
    : state.mode === "COMPOSE"
      ? state.composer
      : state.mode === "SETTINGS"
        ? state.settings?.edit?.composer ?? null
        : null;
}

/** Clipboard path for story prose, independent of terminal selection behavior. */
export async function copyStoryText(state: RuntimeState, target: StoryCopyTarget): Promise<void> {
  const part = rowPart(createStoryViewModel(state.payload, state.stream), state.focusIndex);
  const text = target.kind === "selection"
    ? target.text
    : target.kind === "line"
      ? state.payload.path.map((node) => node.text).join("\n\n")
      : part?.node.text ?? "";
  if (text.length === 0) {
    state.toast = "nothing to copy here";
    return;
  }
  const interactionVersion = state.interactionVersion;
  const outcome = await copyToClipboard(text);
  if (state.interactionVersion !== interactionVersion) return;
  const what = target.kind === "selection"
    ? "selection"
    : target.kind === "line" ? `line · ${state.payload.path.length} parts` : `¶ ${part?.number ?? 0}`;
  state.toast = outcome === "unavailable"
    ? `no clipboard available for ${what} · inline edit or export instead`
    : `copied ${what} · ${countWords(text).toLocaleString("en-US")} words`;
}
