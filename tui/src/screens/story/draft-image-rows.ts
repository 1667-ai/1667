/**
 * One metadata row above the composer for each attached Draft Image, styled
 * as a sibling of the composer's own chrome rows (`composer-chrome.ts`'s
 * `composerFieldLine`) - see `fact-editor-layout.ts` for the splice pattern
 * this mirrors.
 *
 * D12: this renders from numbers already sitting in `StoryImageAttachment`
 * (width, height, byteLength, media type). No decode, no dimension probe,
 * no base64 ever runs here, the metadata was computed once, at stage
 * time, by the server.
 */
import { imageAttachmentLabel, imageMediaTypeLabel } from "../../../../shared/image-attachment.js";
import { formatImageBytes, type DraftImage } from "../../draft-image.js";
import { composerFieldLine } from "./composer-chrome.js";
import type { ComposerLayout } from "./composer.js";
import { segment, truncateTail, visibleWidth, type FrameLine } from "./frame.js";

/** Splice one row per Draft Image between the composer's top rule and its
 *  body, adjusting `lineCount`/`bodyRows`/`cursorViewportRow` by the
 *  inserted count so `contentHeight = height - composerRows - 1`
 *  (screens/story.ts) stays correct. A no-op with no attached images. */
export function spliceDraftImageRows(
  layout: ComposerLayout,
  images: readonly DraftImage[],
  indent: string
): ComposerLayout {
  if (images.length === 0) return layout;
  const rows = draftImageRows(images, indent, layout.fieldWidth);
  const [top, ...rest] = layout.lines;
  if (top === undefined) return layout;
  return {
    ...layout,
    lines: [top, ...rows, ...rest],
    lineCount: layout.lineCount + rows.length,
    bodyRows: layout.bodyRows + rows.length,
    cursorViewportRow: layout.cursorViewportRow + rows.length
  };
}

function draftImageRows(
  images: readonly DraftImage[],
  indent: string,
  fieldWidth: number
): FrameLine[] {
  return images.map((image, index) => {
    const attachment = image.attachment;
    const label = `[${imageAttachmentLabel(index)} · ${imageMediaTypeLabel(attachment.mediaType)}`
      + ` · ${attachment.width}×${attachment.height} · ${formatImageBytes(attachment.byteLength)}]`;
    const remove = "  [remove]";
    const labelWidth = Math.max(1, fieldWidth - visibleWidth(remove) - 1);
    const contents: FrameLine = [
      segment(" ", "compose accent"),
      segment(truncateTail(label, labelWidth), "chrome"),
      segment(remove, "focus / accent", { kind: "action", action: "remove-draft-image", index })
    ];
    return composerFieldLine(indent, fieldWidth, contents);
  });
}
