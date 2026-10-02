import { useMemo } from "react";
import { createManuscriptModel, type ChapterSummaryRow, type StoryRow } from "../../../shared/manuscript-model.js";
import { createStoryIndex } from "../../../shared/story-model.js";
import { takeIndex } from "../../../shared/story-tree.js";
import type { StoryPayload } from "../../../shared/types.js";
import type { ManuscriptGeneration } from "../generation/state.js";
import { StreamingPart } from "../generation/StreamingPart.js";
import { ChapterDivider, ChapterOneHeading } from "./ChapterDivider.js";
import { PartCard } from "./PartCard.js";
import { SummaryBody } from "./SummaryBody.js";

export interface ManuscriptProps {
  readonly payload: StoryPayload;
  readonly focusedPartId: string | null;
  readonly switching: { readonly partId: string; readonly targetId: string } | null;
  readonly showDirections: boolean;
  /** The part whose slot holds the inline editor, if any. */
  readonly editingPartId: string | null;
  /** The `x` key's request, for the part menu that should open. */
  readonly menuRequest: { readonly partId: string; readonly serial: number } | null;
  /** The generation currently writing into (or with unsaved leftover text
   * in) this exact story, if any — `null` the rest of the time. See
   * `generation/state.ts`'s `manuscriptGenerationView`. */
  readonly generation: ManuscriptGeneration | null;
  readonly onFocusPart: (partId: string) => void;
  readonly onSwitch: (partId: string, direction: -1 | 1) => void;
  readonly onSwitchTo: (partId: string, targetId: string) => void;
}

/** Every row up to (and including) the last "part" row whose `pathIndex` is
 * at or before `seamPathIndex`, plus any divider/chapter-summary rows
 * anchored at or before it (they already sit right after their own part in
 * `rows`, by construction — `createManuscriptModel`). Mirrors the TUI's own
 * "projected path" idea (`tui/src/request-projection.ts`): a new take's
 * placeholder replaces every row an old sibling's own continuation left
 * behind, not just the one part being replaced. */
function truncateAtSeam(rows: readonly StoryRow[], seamPathIndex: number): readonly StoryRow[] {
  const cutIndex = rows.findIndex((row) => row.kind === "part" && row.pathIndex > seamPathIndex);
  return cutIndex < 0 ? rows : rows.slice(0, cutIndex);
}

/**
 * The manuscript itself: an ordered list of parts, chapter dividers, and
 * legacy/chapter summaries, from `shared/manuscript-model.ts`'s stream-free
 * model (max reuse with the TUI). Recomputed only when `payload`'s identity
 * changes (every mutation and landed switch replaces it wholesale, so
 * reference equality is exactly the right memo key).
 */
export function Manuscript({ payload, focusedPartId, switching, showDirections, editingPartId, menuRequest, generation, onFocusPart, onSwitch, onSwitchTo }: ManuscriptProps) {
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

  const rows = generation !== null && generation.mode === "take"
    ? truncateAtSeam(model.rows, generation.seamPathIndex)
    : model.rows;

  // While this story is locked (a generation is writing into, or trying to
  // save into, it — `"unsaved"` does not lock), every take control is
  // disabled, not only the ones below a pending switch's own anchor.
  const locked = generation !== null && generation.live;

  return (
    <ol className="manuscript" aria-label="Manuscript">
      <ChapterOneHeading storyId={payload.id} chapters={model.chapters} />
      {rows.map((row) => {
        if (row.kind === "part") {
          const isSwitchingAnchor = switching !== null && row.id === switching.partId;
          return (
            <PartCard
              key={row.id}
              part={row}
              payload={payload}
              focused={row.id === focusedPartId}
              busy={busyFromPathIndex !== null && row.pathIndex > busyFromPathIndex}
              controlsLocked={locked}
              showDirections={showDirections}
              editing={row.id === editingPartId}
              menuSerial={menuRequest?.partId === row.id ? menuRequest.serial : 0}
              displayTakeIndex={isSwitchingAnchor && optimisticTakeIndex !== null ? optimisticTakeIndex : row.takeIndex}
              continuation={generation !== null && generation.appendTo === row.id
                ? { text: generation.text, thinking: generation.thinking, live: generation.live }
                : null}
              onFocus={onFocusPart}
              onSwitch={onSwitch}
              onSwitchTo={onSwitchTo}
            />
          );
        }
        if (row.kind === "chapter-divider") return <ChapterDivider key={row.id} storyId={payload.id} row={row} />;
        return <ChapterSummaryCard key={row.id} row={row} />;
      })}
      {generation !== null && generation.mode === "take" && (
        <StreamingPart
          partNumber={generation.partNumber}
          instruction={generation.instruction}
          showDirections={showDirections}
          text={generation.text}
          thinking={generation.thinking}
          live={generation.live}
        />
      )}
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
