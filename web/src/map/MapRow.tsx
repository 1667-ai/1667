import { memo } from "react";
import { LANE_BUDGET, type LaneRow } from "../../../shared/lane-layout.js";
import type { FactLensNode } from "../../../shared/map-fact-lens.js";
import { opening } from "../../../shared/map-labels.js";
import { workingName } from "../../../shared/story-model.js";
import { LensChip, WritingChip } from "./MapChips.js";

/** One lane's width in the gutter's own drawing units; the stylesheet scales
 * the drawing to `--s-4` per unit. */
const LANE = 16;
const FULL_ROW = 28;
const THIN_ROW = 12;

export interface TreeRowProps {
  readonly row: LaneRow;
  readonly index: number;
  readonly top: number;
  readonly height: number;
  readonly laneCount: number;
  readonly overflow: boolean;
  readonly selected: boolean;
  /** Position among the selectable rows, 1-based; 0 for a row that is none. */
  readonly position: number;
  readonly size: number;
  readonly domId: string;
  readonly chapter: string | null;
  /** True on the row of the take being written (or the leaf being grown). */
  readonly streaming: boolean;
  /** The open Fact lens's reading of this row, or null while no lens is open. */
  readonly lens: FactLensNode | null;
  readonly onSelect: (index: number) => void;
  readonly onAct: (index: number) => void;
  readonly onToggleSketches: () => void;
}

function laneX(lane: number, laneCount: number): number {
  return (lane === -1 ? laneCount : lane) * LANE + LANE / 2;
}

/** The lane gutter: a vertical line per live lane, the row's own mark on its
 * lane, and the elbows where a fork opens or a line closes. Strokes and fills
 * come from CSS classes so every theme applies. */
function LaneGutter({ row, laneCount, overflow, height, lens, streaming }: {
  readonly row: LaneRow; readonly laneCount: number; readonly overflow: boolean; readonly height: number;
  readonly lens: FactLensNode | null; readonly streaming: boolean;
}) {
  const columns = laneCount + (overflow ? 1 : 0);
  const middle = height / 2;
  const parts: React.ReactNode[] = [];
  for (let lane = 0; lane < Math.min(LANE_BUDGET, laneCount); lane += 1) {
    if (row.alive[lane] !== true) continue;
    const x = laneX(lane, laneCount);
    const closing = row.kind === "close" && row.lanes.includes(lane);
    parts.push(
      <line key={`l${lane}`} className={lane === 0 ? "lane-line lane-line-trunk" : "lane-line"} x1={x} y1={0} x2={x} y2={closing ? middle : height} />
    );
  }
  if (row.kind === "fork") {
    const from = laneX(row.lane, laneCount);
    for (const lane of row.toLanes) {
      const to = laneX(lane, laneCount);
      parts.push(<path key={`f${lane}`} className="lane-line" d={`M${from} ${middle}H${to}V${height}`} />);
    }
  }
  if (row.lane !== -1 && (row.parked > 0 || (row.kind === "fork" && row.parkedCount > 0))) {
    const x = laneX(-1, laneCount);
    for (const dx of [-4, 0, 4]) parts.push(<circle key={`p${dx}`} className="lane-parked" cx={x + dx} cy={middle} r={1} />);
  }
  if (row.kind === "node" || row.kind === "end" || row.kind === "sketch" || row.kind === "cold") {
    const x = laneX(row.lane, laneCount);
    if (lens !== null && (lens.anchor || lens.end) && row.kind !== "cold") {
      // The lens marks where a Fact's states are anchored (a diamond) and
      // where it ends (a cross).
      parts.push(lens.end
        ? <path key="end" className="lane-lens-end" d={`M${x - 4} ${middle - 4}l8 8M${x + 4} ${middle - 4}l-8 8`} />
        : <path key="anchor" className="lane-lens-anchor" d={`M${x} ${middle - 6}l6 6l-6 6l-6 -6Z`} />);
    } else if (row.kind === "node") {
      if (row.active) parts.push(<circle key="ring" className="lane-ring" cx={x} cy={middle} r={5.5} />);
      parts.push(<circle key="dot" className={streaming ? "lane-dot lane-dot-writing" : "lane-dot"} cx={x} cy={middle} r={row.active ? 2.5 : 4} />);
    } else if (row.kind === "end") {
      parts.push(<circle key="dot" className="lane-dot lane-dot-end" cx={x} cy={middle} r={4} />);
    } else {
      parts.push(<circle key="dot" className={row.kind === "cold" ? "lane-hollow lane-hollow-cold" : "lane-hollow"} cx={x} cy={middle} r={3.5} />);
    }
  }
  return (
    <svg
      className="map-gutter"
      viewBox={`0 0 ${columns * LANE} ${height}`}
      style={{ "--cols": columns } as React.CSSProperties}
      aria-hidden="true"
      focusable="false"
    >
      {parts}
    </svg>
  );
}

function Label({ row, chapter, streaming, lens }: {
  readonly row: LaneRow; readonly chapter: string | null; readonly streaming: boolean; readonly lens: FactLensNode | null;
}) {
  switch (row.kind) {
    case "node":
      return (
        <>
          <span className="map-part-no">¶ {row.depth}</span>
          <span className="map-text">{row.node.preview.replace(/\s+/g, " ").trim()}</span>
          {streaming && <WritingChip />}
          {lens !== null && <LensChip lens={lens} />}
          {row.tag !== null && <span className="map-chip map-chip-tag" title={`${row.tag.name} ${row.tag.status}`.trim()}>{row.tag.name}</span>}
          {chapter !== null && <span className="map-chip map-chip-chapter" title={`Chapter: ${chapter}`}>§ {chapter}</span>}
        </>
      );
    case "end":
      return (
        <>
          <span className="map-part-no">¶ {row.depth}</span>
          <span className="map-text map-line-name">{row.tag?.name ?? workingName(row.node)}</span>
          {streaming && <WritingChip />}
          {lens !== null && <LensChip lens={lens} />}
          {chapter !== null && <span className="map-chip map-chip-chapter" title={`Chapter: ${chapter}`}>§ {chapter}</span>}
          <span className="map-meta">{row.words.toLocaleString()} w</span>
        </>
      );
    case "sketch":
      return (
        <>
          <span className="map-part-no" />
          <span className="map-text map-dim">“{opening(row.node.preview)}…”</span>
        </>
      );
    case "cold":
      return (
        <>
          <span className="map-part-no" />
          <span className="map-text map-dim">⋯ ×{row.lineCount} {row.lineCount === 1 ? "line" : "lines"} · cold {row.weeks} wks</span>
        </>
      );
    default:
      return null;
  }
}

/** One tree row. Memoized: a cursor move changes `selected` on two rows only,
 * and every other prop is stable for a given layout. */
export const TreeRow = memo(function TreeRow(props: TreeRowProps) {
  const { row, index, top, height, laneCount, overflow, selected, position, size, domId, chapter, streaming, lens } = props;
  const gutter = (
    <LaneGutter
      row={row}
      laneCount={laneCount}
      overflow={overflow}
      height={height <= THIN_ROW ? THIN_ROW : FULL_ROW}
      lens={lens}
      streaming={streaming}
    />
  );
  const place = { top, height };
  if (row.kind === "fork" || row.kind === "close") {
    return <div className="map-row map-row-thin" role="presentation" style={place}>{gutter}</div>;
  }
  if (row.kind === "sketches") {
    return (
      <div className="map-row" role="presentation" style={place}>
        {gutter}
        <span className="map-part-no" />
        <button
          type="button"
          className="map-sketches"
          title="Show sketches (a)"
          onClick={props.onToggleSketches}
        >
          {row.count} {row.count === 1 ? "sketch" : "sketches"}
        </button>
      </div>
    );
  }
  return (
    <div
      id={domId}
      className={`map-row map-row-${row.kind}${lens === null ? "" : ` map-row-lens-${lens.kind}`}`}
      role="option"
      aria-selected={selected}
      aria-current={row.kind === "node" && row.active ? "true" : undefined}
      aria-setsize={size}
      aria-posinset={position}
      style={place}
      onClick={() => props.onSelect(index)}
      onDoubleClick={() => props.onAct(index)}
    >
      {gutter}
      <Label row={row} chapter={chapter} streaming={streaming} lens={lens} />
    </div>
  );
});
