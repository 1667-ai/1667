import type { CliRenderer } from "@opentui/core";
import type { AppMode } from "./keys.js";
import {
  captureNativeSelection,
  type NativeSelectionSnapshot,
  type SelectionProjections
} from "./copy-actions.js";
import type {
  ComposerSelectionProjection,
  StorySelectionProjection
} from "./selection-projection.js";
import type { RuntimeState } from "./state.js";

export interface PresentedSelectionFrame {
  version: number;
  storyId: string;
  interactive: boolean;
  state: { mode: AppMode };
  composerSelectionProjection: ComposerSelectionProjection | null;
  storySelectionProjection: StorySelectionProjection | null;
}

export interface CapturedPresentedSelection {
  frame: PresentedSelectionFrame | null;
  native: NativeSelectionSnapshot | null;
  disposition: "active" | "consumed" | "retired";
}

export interface ReconciledPresentedSelection extends SelectionProjections {
  kind: "captured";
  native: NativeSelectionSnapshot;
}

export type PresentedSelectionResolution =
  | ReconciledPresentedSelection
  | { kind: "none" }
  | { kind: "stale" };

/** Bind even an empty native selection to the frame visible when input
 * arrived, so a later drag cannot be mistaken for that earlier key or paste. */
export function capturePresentedSelection(
  renderer: Pick<CliRenderer, "getSelection">,
  frame: PresentedSelectionFrame | null,
  previous: CapturedPresentedSelection | null = null
): CapturedPresentedSelection {
  const native = captureNativeSelection(renderer);
  if (previous !== null && previous.disposition === "active"
    && samePresentedSelectionOwner(previous.frame, frame)
    && sameNativeSelection(previous.native, native)) {
    return previous;
  }
  return { frame, native, disposition: "active" };
}

/** A failed paint may have rebound OpenTUI's Selection object to partial
 * pixels. Retire that native ownership while preserving the underlying key or
 * paste as ordinary selection-free input for the one recovery attempt. */
export function capturePresentedInputSelection(
  renderer: Pick<CliRenderer, "getSelection" | "clearSelection">,
  frame: PresentedSelectionFrame | null,
  previous: CapturedPresentedSelection | null,
  frameFailed: boolean
): CapturedPresentedSelection {
  if (frameFailed) {
    if (previous !== null) retirePresentedSelection(renderer, previous);
    if (renderer.getSelection() !== null) renderer.clearSelection();
  }
  return capturePresentedSelection(renderer, frame, previous);
}

export function consumePresentedSelection(captured: CapturedPresentedSelection): void {
  if (captured.disposition === "active") captured.disposition = "consumed";
}

/** Permanently retire an unsafe capture. OpenTUI keeps one Selection object
 * while frame content changes, but allocates a new object for a new drag. */
export function retirePresentedSelection(
  renderer: Pick<CliRenderer, "getSelection" | "clearSelection">,
  captured: CapturedPresentedSelection
): void {
  captured.disposition = "retired";
  if (captured.native !== null
    && renderer.getSelection() === captured.native.identity) {
    renderer.clearSelection();
  }
}

/** A noninteractive loading frame cannot own a copy action, even if OpenTUI
 * retains a native range from the surface it replaced. */
export function hasCopyablePresentedSelection(
  captured: CapturedPresentedSelection
): boolean {
  return captured.disposition === "active"
    && captured.frame?.interactive === true
    && captured.native !== null
    && captured.native.text.length > 0;
}

/** Native offsets are safe only against their original semantic frame and
 * projections. Earlier queued reducers may deliberately move to another mode;
 * in that case the later input runs normally without the stale mouse range. */
export function reconcilePresentedSelection(
  captured: CapturedPresentedSelection,
  currentVersion: number,
  state: RuntimeState
): PresentedSelectionResolution {
  if (captured.disposition === "retired") return { kind: "stale" };
  if (captured.disposition === "consumed"
    || captured.native === null || captured.native.text.length === 0) {
    return { kind: "none" };
  }
  const frame = captured.frame;
  if (frame === null
    || !frame.interactive
    || frame.version !== currentVersion
    || frame.storyId !== state.payload.id
    || frame.state.mode !== state.mode) {
    return { kind: "stale" };
  }
  return {
    kind: "captured",
    native: captured.native,
    composer: frame.composerSelectionProjection,
    story: frame.storySelectionProjection
  };
}

/** Animation paints replace the presentation snapshot object without changing
 * semantic selection ownership. Share one consumption token until version,
 * story, mode, or interactivity changes. */
function samePresentedSelectionOwner(
  left: PresentedSelectionFrame | null,
  right: PresentedSelectionFrame | null
): boolean {
  return left === right || (left !== null && right !== null
    && left.version === right.version
    && left.storyId === right.storyId
    && left.interactive === right.interactive
    && left.state.mode === right.state.mode);
}

function sameNativeSelection(
  left: NativeSelectionSnapshot | null,
  right: NativeSelectionSnapshot | null
): boolean {
  if (left === null || right === null) return left === right;
  return left.identity === right.identity
    && left.text === right.text
    && left.backward === right.backward
    && (left.range === right.range || left.range !== null && right.range !== null
      && left.range.start === right.range.start && left.range.end === right.range.end);
}
