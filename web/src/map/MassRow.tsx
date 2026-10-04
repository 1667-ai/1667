import { memo } from "react";
import { shortDate } from "../../../shared/atlas-layout.js";
import { opening } from "../../../shared/map-labels.js";
import { WritingChip } from "./MapChips.js";
import type { MassItem } from "./map-view-model.js";

export interface MassRowProps {
  readonly item: MassItem;
  readonly index: number;
  readonly top: number;
  readonly height: number;
  readonly selected: boolean;
  readonly position: number;
  readonly size: number;
  readonly domId: string;
  /** The largest line's words: the scale of every bar. */
  readonly maximum: number;
  readonly streaming: boolean;
  readonly onSelect: (index: number) => void;
  readonly onAct: (index: number) => void;
  readonly onToggleSketches: () => void;
}

function wordsText(words: number): string {
  return words < 1_000 ? `${words.toLocaleString()} w` : `${(words / 1_000).toFixed(1)}k w`;
}

/** One row of the mass view: the line's name, a bar as long as its words, then
 * its words, its parts and one word of state (where you are, or that it is
 * cold, or its tag's status). Memoized like the tree's rows. */
export const MassRow = memo(function MassRow(props: MassRowProps) {
  const { item, index, top, height, selected, position, size, domId, maximum, streaming } = props;
  const place = { top, height };
  if (item.kind === "fold") {
    return (
      <div className="map-row" role="presentation" style={place}>
        <button type="button" className="map-sketches" title="Show sketches (a)" onClick={props.onToggleSketches}>
          {item.count} {item.count === 1 ? "sketch" : "sketches"} · {wordsText(item.words)}
        </button>
      </div>
    );
  }
  const { row } = item;
  const sketch = row.kind === "sketch";
  const words = sketch ? row.ownWords : row.words;
  const active = row.active && !sketch;
  const percent = words === 0 || maximum === 0 ? 0 : Math.min(100, Math.max(1, Math.round((words / maximum) * 100)));
  const label = sketch ? `“${opening(row.node.preview)}…”` : row.tag?.name ?? `unnamed · ${shortDate(row.node.lastTouched)}`;
  let state = "";
  if (active) state = "you are here";
  else if (row.stale) state = "cold";
  else if (row.tag !== null && row.tag.status.length > 0) state = row.tag.status;
  return (
    <div
      id={domId}
      className={`map-row map-row-mass${active ? " map-row-here" : ""}${sketch ? " map-row-sketch" : ""}`}
      role="option"
      aria-selected={selected}
      aria-current={active ? "true" : undefined}
      aria-setsize={size}
      aria-posinset={position}
      style={place}
      onClick={() => props.onSelect(index)}
      onDoubleClick={() => props.onAct(index)}
    >
      <span className={`map-text mass-name${sketch ? " map-dim" : ""}`}>{label}</span>
      {streaming && <WritingChip />}
      <span className="mass-track" aria-hidden="true">
        <span className={`mass-bar${row.stale && !active ? " mass-bar-cold" : ""}`} style={{ width: `${percent}%` }} />
      </span>
      <span className="map-meta mass-words">{wordsText(words)}</span>
      <span className="map-meta mass-parts">{row.depth} {row.depth === 1 ? "part" : "parts"}</span>
      <span className="map-meta mass-state">{state}</span>
    </div>
  );
});
