/** Shared by `lane-layout.ts` and `atlas-layout.ts`: resolve the cursor row
 *  and slice the visible window around it. Both layouts sort/build their own
 *  rows first, then hand the finished list here to settle the one thing they
 *  do identically. */
export interface WindowedRows<Row> {
  cursorId: string | null;
  rows: Row[];
  allRows: Row[];
  visibleStart: number;
  visibleEnd: number;
  totalRows: number;
  moreRows: number;
}

export interface WindowRowsOptions<Row> {
  /** The row id the caller asked for (`options.cursorId`), if any. */
  wanted: string | null;
  /** Where the cursor falls back to when `wanted` is missing or unselectable. */
  home: string | null;
  selectable: (row: Row) => boolean;
  maxRows?: number;
}

/** Resolves which row the cursor lands on — `wanted` if it names a selectable
 *  row, else `home`, else the first selectable row — stamps `cursor` on every
 *  row accordingly, and slices the `maxRows`-wide window centered on it. */
export function windowRows<Row extends { id: string; cursor: boolean }>(
  allRowsIn: readonly Row[],
  options: WindowRowsOptions<Row>
): WindowedRows<Row> {
  const { wanted, home, selectable, maxRows: maxRowsOption } = options;
  const cursorId = allRowsIn.some((row) => selectable(row) && row.id === wanted)
    ? wanted
    : allRowsIn.find((row) => selectable(row) && row.id === home)?.id
      ?? allRowsIn.find(selectable)?.id ?? null;
  const allRows = allRowsIn.map((row) => ({ ...row, cursor: selectable(row) && row.id === cursorId }) as Row);
  const maxRows = Math.max(1, maxRowsOption ?? (allRows.length || 1));
  const cursorIndex = Math.max(0, allRows.findIndex((row) => row.cursor));
  const visibleStart = Number.isFinite(maxRows)
    ? Math.max(0, Math.min(cursorIndex - Math.floor(maxRows / 2), allRows.length - maxRows)) : 0;
  const rows = allRows.slice(visibleStart, Number.isFinite(maxRows) ? visibleStart + maxRows : undefined);
  return {
    cursorId, rows, allRows,
    visibleStart, visibleEnd: visibleStart + rows.length, totalRows: allRows.length,
    moreRows: Math.max(0, allRows.length - visibleStart - rows.length)
  };
}
