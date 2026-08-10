import type { HitRows } from "../hit.js";
import type { KeyAction } from "../keys.js";
import type { OverlayState } from "../state.js";
import { renderFilePromptPanel } from "./file-prompt-panel.js";
import type { FrameComposition, FrameLine } from "./story/frame.js";

export function renderImageAttachPanel(
  base: FrameLine[],
  state: Pick<OverlayState, "image"> & { hitRows: HitRows },
  width: number,
  height: number,
  footerActions: ReadonlyArray<{ token: string; action: KeyAction }>
): FrameComposition {
  return renderFilePromptPanel(
    base,
    state.image!,
    { title: "attach image", fieldPrefix: "  image   ", note: "PNG, JPEG, or WebP · re-encoded before it is sent" },
    state.hitRows,
    width,
    height,
    footerActions
  );
}
