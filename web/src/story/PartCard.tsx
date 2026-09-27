import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { humanEditIsMeaningful } from "../../../shared/human-edit.js";
import type { StoryPart } from "../../../shared/manuscript-model.js";
import { resolveTakeTarget } from "../../../shared/story-model.js";
import { appendContinuationText } from "../../../shared/story-text.js";
import type { StoryPayload } from "../../../shared/types.js";
import { usePopover } from "../ui/usePopover.js";
import { isClickSelectionCollapsed } from "./focus-dom.js";
import { Prose } from "./Prose.js";
import { SummaryBody } from "./SummaryBody.js";
import { TakePeek } from "./TakePeek.js";
import { TakeStrip } from "./TakeStrip.js";

/** An append streaming into this exact part's leaf (#409 step 5) — `null`
 * for every part that is not the live append target. `live` is false for a
 * frozen `"unsaved"` leftover (no caret; the text still shows, but nothing
 * is still being written). */
export interface PartContinuation {
  readonly text: string;
  readonly thinking: boolean;
  readonly live: boolean;
}

/** Matches `.take-peek`'s CSS `width` (`styles/takes.css`) above the 720px
 * breakpoint, where it shrinks to fit the viewport on its own. */
const TAKE_PEEK_WIDTH = 320;
const TAKE_PEEK_VIEWPORT_MARGIN = 12;

/**
 * The popover's clamped left edge, given the trigger's horizontal center —
 * a plain number, not a `left: 50%; transform: translateX(-50%)` pair:
 * `.take-peek`'s `animation: rise` (`styles/base.css`) ends on `transform:
 * none` (`animation-fill-mode: both`), which would silently override any
 * centering transform set here or in the stylesheet once the entrance
 * animation finishes. Clamped so the popover's full width stays on screen —
 * a trigger near the right edge (a short part, a narrow window) would
 * otherwise run half off-screen.
 */
function clampedPeekLeft(idealCenter: number): number {
  const min = TAKE_PEEK_VIEWPORT_MARGIN;
  const max = window.innerWidth - TAKE_PEEK_WIDTH - TAKE_PEEK_VIEWPORT_MARGIN;
  return Math.min(Math.max(idealCenter - TAKE_PEEK_WIDTH / 2, min), Math.max(min, max));
}

export interface PartCardProps {
  readonly part: StoryPart;
  readonly payload: StoryPayload;
  readonly focused: boolean;
  readonly busy: boolean;
  readonly showDirections: boolean;
  /** The take index to show while a switch on this part is in flight —
   * `part.takeIndex` otherwise (server-authoritative once it lands). */
  readonly displayTakeIndex: number;
  /** Set only on the one part a live append is growing — see `PartContinuation`. */
  readonly continuation?: PartContinuation | null;
  readonly onFocus: (partId: string) => void;
  readonly onSwitch: (partId: string, direction: -1 | 1) => void;
  readonly onSwitchTo: (partId: string, targetId: string) => void;
}

/**
 * One story part. Ported from `~/source/storytavern/web/src/PartCard.tsx`'s
 * read side only — no editing, rewriting, forking, or deletion, all of which
 * belong to later steps (5–6 write the manuscript; this one only reads it).
 * A roving-tabIndex `<article>`: only the focused part is a Tab stop, and
 * `app/keymap.ts` moves that focus with the arrow keys the TUI itself uses.
 */
function PartCardImpl({
  part,
  payload,
  focused,
  busy,
  showDirections,
  displayTakeIndex,
  continuation = null,
  onFocus,
  onSwitch,
  onSwitchTo
}: PartCardProps) {
  const node = part.node;
  const humanEdit = node.attribution ?? null;
  const isLegacySummary = part.isSummary;
  const hasTakes = part.siblingCount > 1;
  const label = hasTakes
    ? `Part ${part.number}, take ${displayTakeIndex} of ${part.siblingCount}`
    : `Part ${part.number}`;

  const peek = usePopover();
  const counterRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    // Escape or an outside press closes the popover through `usePopover`'s
    // own listeners; this is what sends focus back to the counter button
    // afterward (never on the initial, already-closed render).
    if (wasOpenRef.current && !peek.open) counterRef.current?.focus();
    wasOpenRef.current = peek.open;
  }, [peek.open]);

  // The popover portals to `document.body` (see `TakePeek`'s `style` doc),
  // so its position is computed from the trigger's own rect rather than
  // inherited from a CSS-positioned ancestor — recomputed on open and kept
  // live while open, since the manuscript's own scroll container fires
  // `scroll` in the capture phase only (it never bubbles to `window`).
  const [peekRect, setPeekRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!peek.open) {
      setPeekRect(null);
      return;
    }
    const update = (): void => setPeekRect(counterRef.current?.getBoundingClientRect() ?? null);
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [peek.open]);

  const handleMouseUp = (): void => {
    if (isClickSelectionCollapsed()) onFocus(part.id);
  };

  const switchToPosition = (position: number): void => {
    const target = resolveTakeTarget(payload, part.id, position);
    if (target !== null) onSwitchTo(part.id, target.id);
  };

  return (
    <li>
      <article
        className="part"
        data-part-id={part.id}
        tabIndex={focused ? 0 : -1}
        aria-current={focused ? "true" : undefined}
        aria-busy={busy ? "true" : undefined}
        aria-label={label}
        onFocus={() => onFocus(part.id)}
      >
        <div className="part-header">
          <span className="part-number">PART {part.number}</span>
          <span className="part-meta">
            {(isLegacySummary || node.human === true || humanEditIsMeaningful(humanEdit)) && (
              <span className="part-badges">
                {isLegacySummary && <span className="part-badge part-badge-summary">legacy summary</span>}
                {node.human === true && (
                  <span className="part-badge" title="This take began when you typed">your words</span>
                )}
                {humanEditIsMeaningful(humanEdit) && (
                  <span className="part-badge" title="You edited this take's prose">human edit</span>
                )}
              </span>
            )}
          </span>
          {hasTakes && (
            <>
              {/* The TUI's own gutter mark for a forked part (×k,
               *  screens/story/gutter.ts) — a glance-visible sibling count
               *  distinct from the stepper's own "j/k", which only shows
               *  once a reader is already looking at the take switcher. */}
              <span className="label-chip" title={`${part.siblingCount} takes`}>×{part.siblingCount}</span>
              <TakeStrip
                siblingCount={part.siblingCount}
                currentTakeIndex={displayTakeIndex}
                takeSubtakes={part.takeSubtakes}
                disabled={busy}
                onSwitchToPosition={switchToPosition}
              />
              <span className="take-stepper" ref={peek.containerRef}>
                <button
                  type="button"
                  className="icon-btn take-arrow"
                  aria-label={`Previous take (${part.number})`}
                  disabled={busy}
                  onClick={() => onSwitch(part.id, -1)}
                >‹</button>
                <button
                  type="button"
                  ref={counterRef}
                  className="take-count"
                  aria-haspopup="dialog"
                  aria-expanded={peek.open}
                  aria-label={`Take ${displayTakeIndex} of ${part.siblingCount}, show every take`}
                  disabled={busy}
                  onClick={() => peek.setOpen(!peek.open)}
                >{displayTakeIndex}/{part.siblingCount}</button>
                <button
                  type="button"
                  className="icon-btn take-arrow"
                  aria-label={`Next take (${part.number})`}
                  disabled={busy}
                  onClick={() => onSwitch(part.id, 1)}
                >›</button>
                {peek.open && peekRect !== null && createPortal(
                  <TakePeek
                    partId={part.id}
                    payload={payload}
                    currentTakeIndex={displayTakeIndex}
                    disabled={busy}
                    onSwitchTo={onSwitchTo}
                    onClose={() => peek.setOpen(false)}
                    containerRef={peek.popoverRef}
                    style={{
                      position: "fixed",
                      top: peekRect.bottom + 5,
                      left: clampedPeekLeft(peekRect.left + peekRect.width / 2)
                    }}
                  />,
                  document.body
                )}
              </span>
            </>
          )}
        </div>
        {showDirections && node.instruction.length > 0 && (
          <div className="part-instruction">{node.instruction}</div>
        )}
        {isLegacySummary ? (
          <SummaryBody text={node.text} humanEdit={humanEdit} onMouseUp={handleMouseUp} />
        ) : (
          <div onMouseUp={handleMouseUp}>
            <Prose
              text={continuation === null ? node.text : appendContinuationText(node.text, continuation.text)}
              humanEdit={humanEdit}
              caret={continuation !== null && continuation.live && !continuation.thinking}
            />
            {continuation !== null && continuation.thinking && (
              <p className="generation-thinking">Thinking…</p>
            )}
          </div>
        )}
      </article>
    </li>
  );
}

export const PartCard = memo(PartCardImpl);
