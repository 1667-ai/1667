import type { HitRows } from "../hit.js";
import type { KeyAction } from "../keys.js";
import type { OverlayState } from "../state.js";
import { renderFilePromptPanel } from "./file-prompt-panel.js";
import type { FrameComposition, FrameLine } from "./story/frame.js";

export function renderArchiveImportPanel(
  base: FrameLine[],
  state: Pick<OverlayState, "archive"> & { hitRows: HitRows },
  width: number,
  height: number,
  footerActions: ReadonlyArray<{ token: string; action: KeyAction }>
): FrameComposition {
  return renderFilePromptPanel(
    base,
    state.archive!,
    {
      title: "import archive",
      fieldPrefix: "  file    ",
      note: ".lorebook .json → Facts · .scenario .story → new story"
    },
    state.hitRows,
    width,
    height,
    footerActions
  );
}
