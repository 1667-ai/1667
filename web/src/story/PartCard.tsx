import { memo } from "react";
import { humanEditIsMeaningful } from "../../../shared/human-edit.js";
import type { StoryPart } from "../../../shared/manuscript-model.js";
import { Prose } from "./Prose.js";
import { isClickSelectionCollapsed } from "./focus-dom.js";

export interface PartCardProps {
  readonly part: StoryPart;
  readonly focused: boolean;
  readonly busy: boolean;
  readonly showDirections: boolean;
  /** The take index to show while a switch on this part is in flight —
   * `part.takeIndex` otherwise (server-authoritative once it lands). */
  readonly displayTakeIndex: number;
  readonly onFocus: (partId: string) => void;
  readonly onSwitch: (partId: string, direction: -1 | 1) => void;
}

/**
 * One story part. Ported from `~/source/storytavern/web/src/PartCard.tsx`'s
 * read side only — no editing, rewriting, forking, or deletion, all of which
 * belong to later steps (5–6 write the manuscript; this one only reads it).
 * A roving-tabIndex `<article>`: only the focused part is a Tab stop, and
 * `app/keymap.ts` moves that focus with the arrow keys the TUI itself uses.
 */
function PartCardImpl({ part, focused, busy, showDirections, displayTakeIndex, onFocus, onSwitch }: PartCardProps) {
  const node = part.node;
  const humanEdit = node.attribution ?? null;
  const isLegacySummary = part.isSummary;
  const hasTakes = part.siblingCount > 1;
  const label = hasTakes
    ? `Part ${part.number}, take ${displayTakeIndex} of ${part.siblingCount}`
    : `Part ${part.number}`;

  const handleMouseUp = (): void => {
    if (isClickSelectionCollapsed()) onFocus(part.id);
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
              <span className="take-stepper">
                <button
                  type="button"
                  className="icon-btn take-arrow"
                  aria-label={`Previous take (${part.number})`}
                  onClick={() => onSwitch(part.id, -1)}
                >‹</button>
                <span className="take-count">{displayTakeIndex}/{part.siblingCount}</span>
                <button
                  type="button"
                  className="icon-btn take-arrow"
                  aria-label={`Next take (${part.number})`}
                  onClick={() => onSwitch(part.id, 1)}
                >›</button>
              </span>
            </>
          )}
        </div>
        {showDirections && node.instruction.length > 0 && (
          <div className="part-instruction">{node.instruction}</div>
        )}
        {isLegacySummary ? (
          <div className="part-summary-body" onMouseUp={handleMouseUp}>
            <span className="summary-card-label">SUMMARY — THE MODEL READS THIS RECAP</span>
            <Prose text={node.text} humanEdit={humanEdit} />
            <span className="part-summary-note">
              A summary take starts fresh context. Everything above stays in the manuscript.
            </span>
          </div>
        ) : (
          <div onMouseUp={handleMouseUp}>
            <Prose text={node.text} humanEdit={humanEdit} />
          </div>
        )}
      </article>
    </li>
  );
}

export const PartCard = memo(PartCardImpl);
