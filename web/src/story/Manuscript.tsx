import { useMemo } from "react";
import { createManuscriptModel, type ChapterSummaryRow } from "../../../shared/manuscript-model.js";
import { createStoryIndex } from "../../../shared/story-model.js";
import { takeIndex } from "../../../shared/story-tree.js";
import type { StoryPayload } from "../../../shared/types.js";
import { ChapterDivider, ChapterOneHeading } from "./ChapterDivider.js";
import { PartCard } from "./PartCard.js";
import { SummaryBody } from "./SummaryBody.js";

export interface ManuscriptProps {
  readonly payload: StoryPayload;
  readonly focusedPartId: string | null;
  readonly switching: { readonly partId: string; readonly targetId: string } | null;
  readonly showDirections: boolean;
  readonly onFocusPart: (partId: string) => void;
  readonly onSwitch: (partId: string, direction: -1 | 1) => void;
  readonly onSwitchTo: (partId: string, targetId: string) => void;
}

/**
 * The manuscript itself: an ordered list of parts, chapter dividers, and
 * legacy/chapter summaries, from `shared/manuscript-model.ts`'s stream-free
 * model (max reuse with the TUI). Recomputed only when `payload`'s identity
 * changes (every mutation and landed switch replaces it wholesale, so
 * reference equality is exactly the right memo key).
 */
export function Manuscript({ payload, focusedPartId, switching, showDirections, onFocusPart, onSwitch, onSwitchTo }: ManuscriptProps) {
  const model = useMemo(() => createManuscriptModel(payload), [payload]);

  const switchingAnchor = switching === null
    ? null
    : model.parts.find((part) => part.id === switching.partId) ?? null;
  const busyFromPathIndex = switchingAnchor?.pathIndex ?? null;
  const optimisticTakeIndex = useMemo(() => {
    if (switching === null) return null;
    const index = createStoryIndex(payload);
    return takeIndex(index.tree, switching.targetId).index;
  }, [payload, switching]);

  return (
    <ol className="manuscript" aria-label="Manuscript">
      <ChapterOneHeading chapters={model.chapters} />
      {model.rows.map((row) => {
        if (row.kind === "part") {
          const isSwitchingAnchor = switching !== null && row.id === switching.partId;
          return (
            <PartCard
              key={row.id}
              part={row}
              payload={payload}
              focused={row.id === focusedPartId}
              busy={busyFromPathIndex !== null && row.pathIndex > busyFromPathIndex}
              showDirections={showDirections}
              displayTakeIndex={isSwitchingAnchor && optimisticTakeIndex !== null ? optimisticTakeIndex : row.takeIndex}
              onFocus={onFocusPart}
              onSwitch={onSwitch}
              onSwitchTo={onSwitchTo}
            />
          );
        }
        if (row.kind === "chapter-divider") return <ChapterDivider key={row.id} row={row} />;
        return <ChapterSummaryCard key={row.id} row={row} />;
      })}
    </ol>
  );
}

/** A chapter's compact context-reset summary — display only, never a
 * roving-tabIndex focus target (it is not a `part` row: nothing switches or
 * reads its position). Reuses `PartCard`'s legacy-summary body styling. */
function ChapterSummaryCard({ row }: { readonly row: ChapterSummaryRow }) {
  return (
    <li aria-hidden="true">
      <SummaryBody text={row.summary.text ?? ""} className="part" />
    </li>
  );
}
