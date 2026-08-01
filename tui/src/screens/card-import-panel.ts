import type { HitRows } from "../hit.js";
import type { KeyAction } from "../keys.js";
import type { OverlayState } from "../state.js";
import { renderFilePromptPanel } from "./file-prompt-panel.js";
import type { FrameComposition, FrameLine } from "./story/frame.js";

export function renderCardImportPanel(
  base: FrameLine[],
  state: Pick<OverlayState, "card"> & { hitRows: HitRows },
  width: number,
  height: number,
  footerActions: ReadonlyArray<{ token: string; action: KeyAction }>
): FrameComposition {
  return renderFilePromptPanel(
    base,
    state.card!,
    { title: "import character card", fieldPrefix: "  card    " },
    state.hitRows,
    width,
    height,
    footerActions
  );
}
