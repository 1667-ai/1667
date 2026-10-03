import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

/** Rows past the viewport that are drawn anyway, so a fast scroll never shows
 * a blank edge. */
const OVERSCAN = 6;
const FALLBACK_ROW_PX = 28;
const FALLBACK_THIN_PX = 12;

export interface VirtualRows {
  readonly listRef: RefObject<HTMLDivElement | null>;
  /** The rows to draw: `first` up to, not including, `last`. */
  readonly first: number;
  readonly last: number;
  /** `offsets[i]` is row `i`'s top; the last entry is the full height. */
  readonly offsets: Float64Array;
  /** Scrolls just enough to bring a row into view; no-op when it is. */
  readonly ensureVisible: (index: number) => void;
}

function cssPx(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The largest `i` with `offsets[i] <= y`. */
function rowAt(offsets: Float64Array, y: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle]! <= y) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

/**
 * A window over a long, fixed-height list: it keeps the DOM to the rows near
 * the viewport. A full row's height and a thin row's height are read from the
 * design tokens (`--btn-sm`, `--s-3`) on the list element, so CSS stays the
 * one place those numbers live. Scroll is read at most once per animation
 * frame, and a state update happens only when the drawn range changes.
 */
export function useVirtualRows(count: number, thin: Uint8Array | null): VirtualRows {
  const listRef = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState({ row: FALLBACK_ROW_PX, thin: FALLBACK_THIN_PX });
  const offsets = useMemo(() => {
    const result = new Float64Array(count + 1);
    for (let index = 0; index < count; index += 1) {
      result[index + 1] = result[index]! + (thin !== null && thin[index] === 1 ? heights.thin : heights.row);
    }
    return result;
  }, [count, thin, heights]);
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const [range, setRange] = useState({ first: 0, last: 0 });

  const update = useCallback(() => {
    const list = listRef.current;
    if (list === null) return;
    const all = offsetsRef.current;
    const total = all.length - 1;
    const first = Math.max(0, rowAt(all, list.scrollTop) - OVERSCAN);
    const last = Math.min(total, rowAt(all, list.scrollTop + list.clientHeight) + 1 + OVERSCAN);
    setRange((previous) => (previous.first === first && previous.last === last ? previous : { first, last }));
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const style = getComputedStyle(list);
    const row = cssPx(style, "--btn-sm", FALLBACK_ROW_PX);
    const thinRow = cssPx(style, "--s-3", FALLBACK_THIN_PX);
    setHeights((previous) => (previous.row === row && previous.thin === thinRow ? previous : { row, thin: thinRow }));
  }, []);

  useLayoutEffect(update, [offsets, update]);

  useEffect(() => {
    const list = listRef.current;
    if (list === null) return undefined;
    let frame = 0;
    const onScroll = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(list);
    return () => {
      list.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [update]);

  const ensureVisible = useCallback((index: number) => {
    const list = listRef.current;
    const all = offsetsRef.current;
    if (list === null || index < 0 || index >= all.length - 1) return;
    const margin = all[index + 1]! - all[index]!;
    const top = all[index]! - margin;
    const bottom = all[index + 1]! + margin;
    if (top < list.scrollTop) list.scrollTop = Math.max(0, top);
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    update();
  }, [update]);

  // `range` lags one render behind a change of `count` (it is settled in a
  // layout effect), so it is clamped to the rows that exist now.
  return { listRef, first: Math.min(range.first, count), last: Math.min(range.last, count), offsets, ensureVisible };
}
