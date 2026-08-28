import type { CliRenderer, MouseEvent } from "@opentui/core";
import {
  captureNativeSelection,
  storySelectionFromRendererSelection
} from "./copy-actions.js";
import type { ResolvedKey } from "./keys.js";
import type {
  ComposerSelectionProjection,
  StorySelectionProjection
} from "./selection-projection.js";
import { composerRangeFromProjection } from "./selection-projection.js";

type SelectionReader = Pick<CliRenderer, "clearSelection" | "getSelection">;

/** Bind the selected prose before the menu repaint, then replace OpenTUI's
 * buffer-relative selection with semantic source text. Native text remains
 * the fallback for surfaces without a projection. */
export function selectionAwarePartMenuAction(
  event: MouseEvent,
  resolved: ResolvedKey | null,
  renderer: SelectionReader,
  projection: StorySelectionProjection | null = null
): ResolvedKey | null {
  if (resolved?.action === "focus-index" && event.type === "up"
    && (renderer.getSelection()?.getSelectedText().length ?? 0) > 0) {
    return null;
  }
  if ((resolved?.action !== "open-actions" && resolved?.action !== "open-aside-use")
    || event.type !== "down" || event.button !== 2) return resolved;
  const rendered = renderer.getSelection()?.getSelectedText() ?? "";
  const selection = storySelectionFromRendererSelection(renderer, projection);
  const useNative = selection?.hasNativeContent === true;
  const selectionText = useNative ? rendered : selection?.text ?? rendered;
  if (selectionText.length === 0) return resolved;
  event.preventDefault();
  renderer.clearSelection();
  return {
    ...resolved,
    selectionText,
    ...(selection === null || useNative ? {} : { selectionSpans: selection.spans })
  };
}

/** Preserve a native editor selection before the context menu replaces it. */
export function selectionAwareTextMenuAction(
  event: MouseEvent,
  resolved: ResolvedKey | null,
  renderer: SelectionReader,
  projection: ComposerSelectionProjection | null = null
): ResolvedKey | null {
  if (resolved?.action !== "open-text-actions"
    || event.type !== "down"
    || event.button !== 2) {
    return resolved;
  }
  const selection = captureNativeSelection(renderer);
  if (selection === null || selection.text.length === 0) return resolved;
  if (projection === null || selection.range === null) {
    event.preventDefault();
    return resolved;
  }
  const projected = composerRangeFromProjection(
    projection,
    selection.range.start,
    selection.range.end
  );
  if (projected === null) {
    event.preventDefault();
    return resolved;
  }
  if (projected.kind === "mixed") {
    event.preventDefault();
    return null;
  }
  event.preventDefault();
  renderer.clearSelection();
  return {
    ...resolved,
    nativeSelection: selection,
    ...(projection === null ? {} : { composerSelectionProjection: projection })
  };
}
