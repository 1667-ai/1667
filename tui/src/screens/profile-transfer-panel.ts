import { raisedSegment, placePanel, panelHorizontalGeometry } from "./overlay.js";
import { cellPad } from "./panel-table-layout.js";
import { truncate, type FrameComposition, type FrameLine } from "./story/frame.js";
import type { ProfileTransferPrompt } from "../state.js";
import type { HitRows } from "../hit.js";
import { renderFilePromptPanel } from "./file-prompt-panel.js";
import { STARTER_PROFILES } from "../../../shared/generation-profile-starters.js";

export const PROFILE_TRANSFER_SOURCES = [...STARTER_PROFILES.map(({ name }) => name), "read a file…"] as const;

export function renderProfileTransferPanel(
  base: FrameLine[],
  prompt: ProfileTransferPrompt,
  hitRows: HitRows,
  width: number,
  height: number
): FrameComposition {
  if (prompt.phase === "file") {
    return renderFilePromptPanel(
      base,
      prompt,
      { title: "import generation profile", fieldPrefix: "  file    ", note: ".preset or Profile Export JSON" },
      hitRows,
      width,
      height,
      [{ token: "tab", action: "complete" }, { token: "↵", action: "apply-profile-transfer" }, { token: "esc", action: "cancel" }]
    );
  }
  const contentWidth = panelHorizontalGeometry(width, 56).contentWidth;
  const content: FrameLine[] = PROFILE_TRANSFER_SOURCES.map((name, index) => [raisedSegment(cellPad(index === prompt.cursor ? "▸ " : "  ", 2), index === prompt.cursor ? "focus / accent" : "chrome"), raisedSegment(truncate(name, contentWidth - 2), index === prompt.cursor ? "focus / accent" : "prose")]);
  if (prompt.error !== null) content.push([raisedSegment(truncate(prompt.error, contentWidth), "danger")]);
  return placePanel(base, "profile source", content, "↑↓ choose · ↵ apply · esc cancel", width, height, 56, { rows: [], targets: content.map(() => null), overrides: content.map(() => []) });
}
