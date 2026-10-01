import { useEffect, useRef, type RefObject } from "react";

/** Within this many pixels of the bottom counts as "at the bottom" — close
 * enough that a reader who has not deliberately scrolled up should keep
 * following new text as it arrives. */
const PINNED_THRESHOLD_PX = 48;

/**
 * Keeps the manuscript scrolled to the bottom while a generation streams,
 * exactly like a chat view's own "stick to bottom" behavior: pinned while
 * the reader is within `PINNED_THRESHOLD_PX` of the bottom, and only then —
 * scrolling up even slightly un-pins it (their scroll wins), and scrolling
 * back down to the bottom re-pins it. `dep` is whatever value changes each
 * time new content should be considered for a follow-scroll (the
 * presented generation text, throttled the same way the store's own copy
 * is) — this hook never reads the buffer itself.
 */
export function useFollowStream(
  scrollRef: RefObject<HTMLElement | null>,
  active: boolean,
  dep: unknown
): void {
  const pinnedRef = useRef(true);

  useEffect(() => {
    if (!active) {
      pinnedRef.current = true;
      return undefined;
    }
    const container = scrollRef.current;
    if (container === null) return undefined;
    const onScroll = (): void => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      pinnedRef.current = distanceFromBottom <= PINNED_THRESHOLD_PX;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [scrollRef, active]);

  useEffect(() => {
    if (!active) return;
    const container = scrollRef.current;
    if (container === null || !pinnedRef.current) return;
    container.scrollTop = container.scrollHeight;
    // `dep` (not `scrollRef`, which never changes) drives this effect — see
    // the module doc.
  }, [active, dep]);
}
