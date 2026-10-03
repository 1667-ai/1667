import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  continuationStats,
  createStoryIndex,
  formatAge,
  rememberedLineTag,
  virtualRange
} from "../../../shared/story-model.js";
import { childrenOf } from "../../../shared/story-tree.js";
import { StatusChip } from "../tags/StatusChip.js";
import type { NodeStub, StoryPayload } from "../../../shared/types.js";

export interface TakePeekProps {
  readonly partId: string;
  readonly payload: StoryPayload;
  readonly currentTakeIndex: number;
  readonly disabled: boolean;
  readonly onSwitchTo: (partId: string, targetId: string) => void;
  readonly onClose: () => void;
  /** `PartCard.tsx` renders this through a portal (`document.body`) and
   * supplies `position: fixed` coordinates computed from the counter
   * button's own rect — a plain `position: absolute` popover nested inside
   * `.story-scroll` (`overflow-y: auto`) gets clipped, and any row that
   * lands past the clip is both invisible and unclickable. Overrides the
   * `.take-peek` class's own `position`/`top`/`left`/`transform`. */
  readonly style: React.CSSProperties;
  /** `ui/usePopover.ts`'s `popoverRef` — attached to this component's own
   * root so a press inside a portal-rendered popover still counts as
   * "inside" for the caller's outside-press-closes behavior. */
  readonly containerRef: RefObject<HTMLDivElement | null>;
}

const VIRTUAL_THRESHOLD = 50;
/** One row's height in the virtual list: heading, two snippet lines, meta. */
const ROW_HEIGHT = 88;
const VIEWPORT_HEIGHT = 360;
const OVERSCAN = 3;

/**
 * The counter button's popover: every sibling take, stubs only (no
 * `getTakeLine` — switching is what actually loads one). Ported from
 * `~/source/storytavern/web/src/TakePeek.tsx`'s row layout; opened/closed
 * and Escape/outside-press-closed by the caller's `ui/usePopover.ts` (this
 * component owns no open state of its own), which is also what returns
 * focus to the counter button on close.
 */
export function TakePeek({ partId, payload, currentTakeIndex, disabled, onSwitchTo, onClose, style, containerRef }: TakePeekProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const index = createStoryIndex(payload);
  const node = index.tree.nodesById.get(partId);
  const parentId = node?.parentId ?? null;
  const takes = childrenOf(index.tree, parentId);
  const virtual = takes.length > VIRTUAL_THRESHOLD;

  useLayoutEffect(() => {
    if (!virtual || listRef.current === null) return;
    const activeIndex = currentTakeIndex - 1;
    const next = Math.max(0, activeIndex * ROW_HEIGHT - (VIEWPORT_HEIGHT - ROW_HEIGHT) / 2);
    listRef.current.scrollTop = next;
    setScrollTop(next);
    // Only on mount — a later reposition would fight the reader's own scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Move keyboard focus into the preview so its rows, not the manuscript
  // behind it, receive the keys.
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, []);

  const range = virtual
    ? virtualRange(takes.length, scrollTop, ROW_HEIGHT, VIEWPORT_HEIGHT, OVERSCAN)
    : { start: 0, end: takes.length };

  const row = (take: NodeStub, offset: number, virtualRow: boolean) => {
    const position = offset + 1;
    const active = position === currentTakeIndex;
    const tag = rememberedLineTag(payload, take.id, index);
    const continuation = continuationStats(payload, take.id, index);
    return (
      <button
        type="button"
        key={take.id}
        className={`take-peek-row${active ? " active" : ""}${virtualRow ? " virtual-row" : ""}`}
        style={virtualRow ? { top: offset * ROW_HEIGHT, height: ROW_HEIGHT } : undefined}
        disabled={disabled || active}
        title={active ? "Reading" : `Take ${position}`}
        onClick={() => {
          onClose();
          onSwitchTo(partId, take.id);
        }}
      >
        <span className="take-peek-heading">
          <span>Take {position}/{takes.length}{active ? " — reading" : ""}</span>
          {tag?.status === "Canon" && <span className="canon-mark" title="Canon">★</span>}
          {tag !== null && (tag.status.length > 0 ? <StatusChip status={tag.status} /> : <span className="label-chip">{tag.name}</span>)}
        </span>
        <span className="take-peek-snippet">{take.preview || "No prose yet."}</span>
        <span className={`take-peek-meta${continuation.parts === 0 ? " ends" : ""}`}>
          {continuation.parts === 0
            ? "Ends here"
            : `${continuation.parts} ${continuation.parts === 1 ? "part" : "parts"} · ${continuation.words.toLocaleString()} words below`}
          <span>{formatAge(take.lastTouched).toLowerCase()}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="take-peek" style={style} ref={containerRef} role="dialog" aria-label="Take preview" data-owns-keys="">
      <header>{takes.length} takes</header>
      <div
        className={`take-peek-list${virtual ? " virtual" : ""}`}
        ref={listRef}
        onScroll={virtual ? (event) => setScrollTop(event.currentTarget.scrollTop) : undefined}
      >
        {virtual ? (
          <div className="take-peek-window" style={{ height: takes.length * ROW_HEIGHT }}>
            {takes.slice(range.start, range.end).map((take, offset) => row(take, range.start + offset, true))}
          </div>
        ) : takes.map((take, offset) => row(take, offset, false))}
      </div>
      <footer><span>Stubs only — prose loads on switch</span></footer>
    </div>
  );
}
