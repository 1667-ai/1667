import {
  visibleApparatusDoorways,
  type ApparatusDoorway,
  type ApparatusSeam
} from "../../apparatus-model.js";
import type { StoryPart } from "../../model.js";
import { STORY_GUTTER } from "../../composer-geometry.js";
import {
  fitLine,
  segment,
  truncate,
  visibleWidth,
  type FrameLine
} from "./frame.js";

export interface ApparatusBand {
  readonly height: number;
  readonly lines: FrameLine[];
}

/** Keep the beta surface honest: inactive nodes provide previews, not text
 * readings. The band therefore names each row as a take doorway. */
export function renderApparatusBand(
  seam: ApparatusSeam,
  part: StoryPart,
  measure: number,
  narrow: boolean,
  armed: boolean
): ApparatusBand | null {
  if (seam.kind !== "not-yet" || seam.doorways.length === 0) return null;

  const shown = visibleApparatusDoorways(seam, narrow);
  const remaining = seam.doorways.length - shown.length;
  const lines: FrameLine[] = [
    bandLine([
      segment("── apparatus · ", "chrome"),
      segment(`¶${part.number} · site 1 · negative · `, "chrome"),
      segment(`${seam.takeCount} takes`, "focus / accent"),
      segment(" ──", "chrome")
    ], measure, narrow),
    bandLine([
      segment(armed
        ? "active take omitted · site 1 armed · "
        : "active take omitted · stored previews · ", "brass dim"),
      segment(armed ? "letter selects take" : "1 + letter selects take", "focus / accent")
    ], measure, narrow)
  ];
  lines.push(...shown.map((doorway) => doorwayLine(doorway, part.id, measure, narrow)));
  if (remaining > 0) {
    lines.push(bandLine([
      segment(`+ ${remaining} more takes`, "brass dim"),
      ...(armed ? [] : [segment(" · m opens map", "chrome")])
    ], measure, narrow));
  }
  lines.push(bandLine([
    segment("── end apparatus ──", "chrome")
  ], measure, narrow));
  return { height: lines.length, lines };
}

function doorwayLine(
  doorway: ApparatusDoorway,
  rowId: string,
  measure: number,
  narrow: boolean
): FrameLine {
  const label = doorway.label ?? "—";
  const preview = doorway.preview.replace(/\s+/gu, " ").trim();
  const text = preview.length === 0 ? "⟨not yet generated⟩" : `"${preview}"`;
  const prefix = `1  ${label}  `;
  const continuation = doorway.childCount > 0
    ? ` ↗ ¶+${doorway.childCount}`
    : " ✕";
  const suffix = continuation;
  const previewWidth = Math.max(1, measure - visibleWidth(prefix) - visibleWidth(suffix));
  const previewText = truncate(text, previewWidth);
  const hit = { kind: "story-take" as const, take: doorway.takeIndex, rowId };
  return bandLine([
    segment(prefix, "chrome", hit),
    segment(previewText, doorway.label === null ? "brass dim" : "prose · dim", hit),
    segment(suffix, "brass dim", hit)
  ], measure, narrow);
}

function bandLine(content: FrameLine, measure: number, narrow: boolean): FrameLine {
  const indent = narrow ? "  " : " ".repeat(STORY_GUTTER);
  return fitLine([segment(indent), ...content], visibleWidth(indent) + measure);
}
