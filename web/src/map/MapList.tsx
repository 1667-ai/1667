import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { useVirtualRows } from "./useVirtualRows.js";

export interface MapListProps {
  readonly label: string;
  readonly count: number;
  /** 1 for a thin row (see `map-view-model.ts`); `null` when every row is full. */
  readonly thin: Uint8Array | null;
  /** The row the cursor is on; kept in view. */
  readonly activeIndex: number;
  readonly activeDomId: string | null;
  /** Changes whenever the list should take keyboard focus back. */
  readonly focusToken: number;
  readonly renderRow: (index: number, top: number, height: number) => ReactNode;
}

/**
 * The map's scrolling listbox. Only the rows near the viewport are in the DOM
 * (`useVirtualRows`); the list itself holds keyboard focus and names the
 * cursor's row with `aria-activedescendant`, so a cursor move never moves DOM
 * focus between rows.
 */
export function MapList({ label, count, thin, activeIndex, activeDomId, focusToken, renderRow }: MapListProps) {
  const { listRef, first, last, offsets, ensureVisible } = useVirtualRows(count, thin);

  // Only a cursor that moved (or whose row moved) scrolls the list: a reload
  // of the same story must not pull the reader back from where they scrolled.
  useLayoutEffect(() => {
    ensureVisible(activeIndex);
  }, [activeIndex, ensureVisible]);

  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, [focusToken, listRef]);

  const rows: ReactNode[] = [];
  for (let index = first; index < last; index += 1) {
    rows.push(renderRow(index, offsets[index]!, offsets[index + 1]! - offsets[index]!));
  }
  return (
    <div
      ref={listRef}
      className="map-list"
      role="listbox"
      aria-label={label}
      aria-activedescendant={activeDomId ?? undefined}
      tabIndex={0}
    >
      <div className="map-canvas" role="presentation" style={{ height: offsets[count] }}>
        {rows}
      </div>
    </div>
  );
}
