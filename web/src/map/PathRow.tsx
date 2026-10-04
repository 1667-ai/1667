import { memo, type CSSProperties, type MouseEvent } from "react";
import type { PathRow as PathLayoutRow } from "../../../shared/path-layout.js";
import { WritingChip } from "./MapChips.js";

const CELL = 16;
/** Room for up to five sibling takes plus a "more" mark on each side. */
const COLUMNS = 7;
const HEIGHT = 28;

export interface PathRowProps {
  readonly row: PathLayoutRow;
  readonly index: number;
  readonly top: number;
  readonly height: number;
  readonly selected: boolean;
  /** The cursor's node id; given to the selected row only, so a cursor move
   * re-renders two rows. */
  readonly cursorId: string | null;
  readonly position: number;
  readonly size: number;
  readonly domId: string;
  readonly chapter: string | null;
  /** The id of the take being written (or the leaf an append grows). */
  readonly streamId: string | null;
  readonly onSelect: (index: number, nodeId: string | null) => void;
  readonly onAct: (index: number) => void;
}

function cellX(offset: number): number {
  return (offset + 1) * CELL + CELL / 2;
}

/** One row of the cursor's line: the part's number and text, with its sibling
 * takes drawn as marks in the gutter. */
export const PathRow = memo(function PathRow(props: PathRowProps) {
  const { row, index, top, height, selected, cursorId, position, size, domId, chapter, streamId } = props;
  const shownCell = row.cells.find((cell) => cell.node.id === cursorId)
    ?? row.cells.find((cell) => cell.node.id === row.pathNode.id)
    ?? null;
  const shown = shownCell?.node ?? row.pathNode;
  const middle = HEIGHT / 2;
  const writing = streamId !== null && row.cells.some((cell) => cell.node.id === streamId);
  const marks: React.ReactNode[] = [];
  if (row.cells.length > 1) {
    marks.push(<line key="rail" className="lane-line" x1={cellX(0)} y1={middle} x2={cellX(row.cells.length - 1)} y2={middle} />);
  }
  if (row.hiddenBefore > 0) marks.push(<path key="more-before" className="lane-more" d={`M${CELL / 2 + 2} ${middle - 3}l-3 3l3 3`} />);
  if (row.hiddenAfter > 0) marks.push(<path key="more-after" className="lane-more" d={`M${(COLUMNS - 1) * CELL + CELL / 2 - 2} ${middle - 3}l3 3l-3 3`} />);
  for (const [offset, cell] of row.cells.entries()) {
    const x = cellX(offset);
    const isCursor = cell.node.id === cursorId;
    // The group carries the id, so a click on the visible dot or ring
    // selects this take too.
    marks.push(
      <g key={`take-${cell.node.id}`} data-node={cell.node.id}>
        <circle className="lane-hit" cx={x} cy={middle} r={7} />
        {isCursor ? <circle className="lane-ring" cx={x} cy={middle} r={5.5} /> : null}
        <circle
          className={cell.node.id === streamId ? "lane-dot lane-dot-writing" : cell.active ? "lane-dot" : cell.subtakes ? "lane-dot lane-dot-end" : "lane-hollow"}
          cx={x}
          cy={middle}
          r={cell.active || cell.subtakes ? 3.5 : 3}
        />
      </g>
    );
  }
  const select = (event: MouseEvent<HTMLDivElement>): void => {
    const hit = (event.target as Element).closest<SVGElement>("[data-node]");
    props.onSelect(index, hit?.dataset.node ?? null);
  };
  const counter = shownCell !== null && shownCell.takeCount > 1 ? `take ${shownCell.take} of ${shownCell.takeCount}` : null;
  return (
    <div
      id={domId}
      className="map-row map-row-path"
      role="option"
      aria-selected={selected}
      aria-current={shownCell?.active === true && shown.childCount === 0 ? "true" : undefined}
      aria-setsize={size}
      aria-posinset={position}
      style={{ top, height }}
      onClick={select}
      onDoubleClick={() => props.onAct(index)}
    >
      <svg
        className="map-gutter"
        viewBox={`0 0 ${COLUMNS * CELL} ${HEIGHT}`}
        style={{ "--cols": COLUMNS } as CSSProperties}
        aria-hidden="true"
        focusable="false"
      >
        {marks}
      </svg>
      <span className="map-part-no">¶ {row.depth}</span>
      {writing && shown.preview.trim().length === 0
        ? <span className="map-text map-dim">Writing…</span>
        : (
          <>
            <span className="map-text">{shown.preview.replace(/\s+/g, " ").trim()}</span>
            {writing && <WritingChip />}
          </>
        )}
      {shownCell?.tag != null && <span className="map-chip map-chip-tag" title={shownCell.tag.name}>{shownCell.tag.name}</span>}
      {chapter !== null && <span className="map-chip map-chip-chapter" title={`Chapter: ${chapter}`}>§ {chapter}</span>}
      {counter !== null && <span className="map-meta">{counter}</span>}
    </div>
  );
});
