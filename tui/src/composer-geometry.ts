import type { UserConfig } from "./config.js";
import { deriveStoryFrameLayout } from "./story-frame-layout.js";
import { visibleWidth } from "./screens/story/frame.js";

/** Fixed-width left gutter reserved for story row verbs and take counters, in
 *  cells. Shared by row layout and composer geometry so both agree on where
 *  the prose column starts. */
export const STORY_GUTTER = 24;

export function storyProseMeasure(pageWidth: number): number {
  return Math.max(1, Math.min(72, pageWidth < 100 ? pageWidth - 4 : pageWidth - 26));
}

/** Painted width of the composer field. */
export function composerFieldWidth(
  fullscreen: boolean,
  terminalWidth: number,
  measure: number,
  indent: string
): number {
  const bounded = Math.max(8, Math.floor(terminalWidth));
  return fullscreen
    ? bounded
    : Math.max(8, Math.min(
      Math.floor(measure),
      Math.max(8, bounded - visibleWidth(indent))
    ));
}

/** Cells one wrapped row holds. Paint and vertical motion both read this, so a
 *  wrapped caret lands on the row the writer sees. */
export function composerInputWidth(fieldWidth: number): number {
  return Math.max(1, fieldWidth - visibleWidth("┃ ") - visibleWidth("› "));
}

/** Cells the Direct composer wraps at, for the geometry it is painted with.
 *  Vertical motion reads this so an arrow key follows the painted rows. */
export function directComposerWrapWidth(
  terminalWidth: number,
  config: UserConfig,
  fullscreen: boolean
): number {
  if (fullscreen) {
    return composerInputWidth(
      composerFieldWidth(true, terminalWidth, terminalWidth, "")
    );
  }
  const pageWidth = deriveStoryFrameLayout(terminalWidth, config).pageWidth;
  const indent = pageWidth < 100 ? "  " : " ".repeat(STORY_GUTTER);
  return composerInputWidth(composerFieldWidth(
    false, pageWidth, storyProseMeasure(pageWidth), indent
  ));
}
