import type { CliRenderer, MouseEvent } from "@opentui/core";
import { storySelectionFromRendererSelection } from "./copy-actions.js";
import type { ResolvedKey } from "./keys.js";
import type { StorySelectionProjection } from "./selection-projection.js";

type SelectionReader = Pick<CliRenderer, "clearSelection" | "getSelection">;

/** Bind the selected prose before the menu repaint, then replace OpenTUI's
 * buffer-relative selection with semantic highlighting of the source text. */
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
  if (resolved?.action !== "open-actions" || event.type !== "down" || event.button !== 2) return resolved;
  const rendered = renderer.getSelection()?.getSelectedText() ?? "";
  const selection = storySelectionFromRendererSelection(renderer, projection);
  const selectionText = selection?.text ?? rendered;
  if (selectionText.length === 0) return resolved;
  event.preventDefault();
  renderer.clearSelection();
  return {
    ...resolved,
    selectionText,
    ...(selection === null ? {} : { selectionSpans: selection.spans })
  };
}
