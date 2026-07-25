import type { UserConfig } from "./config.js";
import type { AppMode } from "./keys.js";
import { railVisible, RAIL_WIDTH } from "./rail.js";

export const RAIL_RIGHT_MARGIN = 2;

/** Physical columns shared by frame rendering, selection buffers, and hits. */
export interface StoryFrameLayout {
  fullWidth: number;
  pageWidth: number;
  /** Separator column and start of the non-selectable rail buffer. */
  railStart: number | null;
  /** First clickable rail column, immediately after the separator. */
  factLeft: number | null;
  /** Exclusive clickable edge; remaining columns are quiet right margin. */
  railRight: number | null;
}

export function deriveStoryFrameLayout(width: number, config: UserConfig, mode?: AppMode): StoryFrameLayout {
  if (!railVisible(width, config, mode)) return singlePaneStoryFrameLayout(width);
  const railStart = width - RAIL_WIDTH - 1 - RAIL_RIGHT_MARGIN;
  return {
    fullWidth: width,
    pageWidth: railStart,
    railStart,
    factLeft: railStart + 1,
    railRight: width - RAIL_RIGHT_MARGIN
  };
}

export function singlePaneStoryFrameLayout(width: number): StoryFrameLayout {
  return {
    fullWidth: width,
    pageWidth: width,
    railStart: null,
    factLeft: null,
    railRight: null
  };
}
