import type { HitRow } from "../hit.js";
import type { NodeStub } from "../../../shared/types.js";
import { formatMapWords } from "./map-row-labels.js";
import { segment, truncate, visibleWidth, type FrameLine } from "./story/frame.js";

/** The mass/lane preview pair — ¶ depth and the cursor row's own words —
 *  shared by every full-bleed map body that has room for it. */
export function appendMapPreview(
  lines: FrameLine[],
  hits: Array<HitRow | null>,
  cursor: { depth: number; node: NodeStub } | null,
  width: number
): void {
  if (width < 100 || cursor === null) return;
  const detail = `¶ ${cursor.depth} · ${formatMapWords(cursor.node.words)}`;
  const preview = truncate(
    cursor.node.preview.replace(/\s+/g, " ").trim(),
    Math.max(8, width - visibleWidth(detail) - 8)
  );
  lines.push([], [segment("  ‥ ", "summary"), segment(preview, "summary"),
    segment(" ".repeat(Math.max(1, width - visibleWidth(preview) - visibleWidth(detail) - 5))), segment(detail, "chrome")]);
  hits.push(null, null);
}
