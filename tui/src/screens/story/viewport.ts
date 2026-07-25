import type { FrameLine } from "./frame.js";

export interface ViewportBlock {
  partId: string;
  partIndex: number;
  height: number;
  render(): FrameLine[];
}

export interface Viewport {
  lines: FrameLine[];
  owners: number[];
  /** Row offset inside the owning block, parallel to `lines`/`owners`. */
  blockRows: number[];
  viewScroll: number | null;
  start: number;
}

/** Window rendered story blocks while preserving their owning row indexes. */
export function viewportLines(
  blocks: ViewportBlock[],
  focusId: string | null,
  height: number,
  centered: boolean,
  requestedScroll: number | null,
  relativeScroll = 0
): Viewport {
  const bodyHeight = blocks.reduce((sum, block) => sum + block.height, 0);
  let viewScroll = requestedScroll;
  let start = 0;
  if (bodyHeight <= height) {
    viewScroll = null;
  } else if (viewScroll !== null) {
    start = Math.max(0, Math.min(bodyHeight - height, viewScroll));
    viewScroll = start;
  } else {
    let focusEnd = height;
    let offset = 0;
    for (const block of blocks) {
      offset += block.height;
      if (block.partId === focusId) {
        focusEnd = offset;
        break;
      }
    }
    start = Math.max(0, Math.min(bodyHeight - height, focusEnd - (centered ? Math.ceil(height / 2) : height)));
    if (relativeScroll !== 0) {
      start = Math.max(0, Math.min(bodyHeight - height, start + relativeScroll));
      viewScroll = start;
    }
  }
  const end = start + height;
  const lines: FrameLine[] = [];
  const owners: number[] = [];
  const blockRows: number[] = [];
  let offset = 0;
  for (const block of blocks) {
    const blockEnd = offset + block.height;
    if (blockEnd > start && offset < end) {
      const rendered = block.render();
      if (rendered.length !== block.height) {
        throw new Error(`viewport block ${block.partId} measured ${block.height} rows but rendered ${rendered.length}`);
      }
      const from = Math.max(0, start - offset);
      const to = Math.min(block.height, end - offset);
      lines.push(...rendered.slice(from, to));
      owners.push(...Array.from({ length: to - from }, () => block.partIndex));
      blockRows.push(...Array.from({ length: to - from }, (_, index) => from + index));
    }
    offset = blockEnd;
    if (offset >= end) break;
  }
  return { lines, owners, blockRows, viewScroll, start };
}
