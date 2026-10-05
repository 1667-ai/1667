import { Fragment, useMemo } from "react";
import { type StoryRow } from "../../../shared/manuscript-model.js";
import { manuscriptModelOf } from "./manuscript-model.js";
import { createStoryIndex } from "../../../shared/story-model.js";
import { takeIndex } from "../../../shared/story-tree.js";
import type { StoryPayload } from "../../../shared/types.js";
import type { ManuscriptGeneration } from "../generation/state.js";
import { StreamingPart } from "../generation/StreamingPart.js";
import { forkTakeOf } from "./line-switch.js";
import { ChapterDivider, ChapterOneHeading } from "./ChapterDivider.js";
import { PlacementGap } from "../aside/PlacementBar.js";
import { indexOfPick, placementStops, type PlacementPick } from "../aside/placement.js";
import { PartCard, type PartContinuation } from "./PartCard.js";
import { SummaryCard } from "../chapters/SummaryCard.js";
import { SummaryTakeCard } from "../chapters/SummaryTakeCard.js";
import type { SummaryRun } from "../chapters/state.js";

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
  /** The chapter summary running in this story, if any. */
  readonly summaryRun: SummaryRun | null;
  /** The place picked for an Aside answer ("Insert here"), while the writer is choosing. */
  readonly placement: PlacementPick | null;
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
/** What a part shows of the run writing into it: an append grows the leaf, a
 * rewrite puts its text where the passage was. */
function continuationOf(generation: ManuscriptGeneration, partId: string): PartContinuation | null {
  const shared = { text: generation.text, thinking: generation.thinking, live: generation.live };
  if (generation.appendTo === partId) return shared;
  if (generation.rewrite !== null && generation.rewrite.partId === partId) {
    return { ...shared, rewrite: { start: generation.rewrite.start, end: generation.rewrite.end } };
  }
  return null;
}

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
export function Manuscript({ payload, focusedPartId, switching, showDirections, editingPartId, menuRequest, generation, summaryRun, placement, onFocusPart, onSwitch, onSwitchTo }: ManuscriptProps) {
  const model = useMemo(() => manuscriptModelOf(payload), [payload]);

  const switchingAnchor = switching === null
    ? null
    : model.parts.find((part) => part.id === switching.partId) ?? null;
  const busyFromPathIndex = switchingAnchor?.pathIndex ?? null;
  const optimisticTakeIndex = useMemo(() => {
    if (switching === null) return null;
    const index = createStoryIndex(payload);
    // The target may sit deeper than the anchor (a switch from the map): the
    // anchor shows the take its line runs through.
    const anchorDepth = index.depthByNodeId.get(switching.partId) ?? 0;
    return takeIndex(index.tree, forkTakeOf(index, switching.targetId, anchorDepth)).index;
  }, [payload, switching]);

  const rows = generation !== null && generation.mode === "take"
    ? truncateAtSeam(model.rows, generation.seamPathIndex)
    : model.rows;

  // While this story is locked (a generation is writing into, or trying to
  // save into, it — `"unsaved"` does not lock), every take control is
  // disabled, not only the ones below a pending switch's own anchor.
  const stops = useMemo(() => (placement === null ? [] : placementStops(payload)), [payload, placement]);
  const pickedStop = placement === null ? -1 : indexOfPick(stops, placement);

  const locked = (generation !== null && generation.live) || summaryRun !== null;

  return (
    <ol className="manuscript" aria-label="Manuscript">
      <ChapterOneHeading storyId={payload.id} chapters={model.chapters} />
      {rows.map((row, index) => {
        if (row.kind === "part") {
          const isSwitchingAnchor = switching !== null && row.id === switching.partId;
          const stopIndex = placement === null ? -1 : stops.findIndex((stop) => stop.kind === "take" && stop.partId === row.id);
          return (
            <Fragment key={row.id}>
              {stopIndex >= 0 && <PlacementGap stop={stops[stopIndex]!} selected={stopIndex === pickedStop} />}
              <PartCard
                part={row}
                payload={payload}
                focused={row.id === focusedPartId}
                busy={busyFromPathIndex !== null && row.pathIndex > busyFromPathIndex}
                controlsLocked={locked}
                showDirections={showDirections}
                editing={row.id === editingPartId}
                menuSerial={menuRequest?.partId === row.id ? menuRequest.serial : 0}
                displayTakeIndex={isSwitchingAnchor && optimisticTakeIndex !== null ? optimisticTakeIndex : row.takeIndex}
                continuation={generation === null ? null : continuationOf(generation, row.id)}
                onFocus={onFocusPart}
                onSwitch={onSwitch}
                onSwitchTo={onSwitchTo}
              />
            </Fragment>
          );
        }
        if (row.kind === "chapter-divider") {
          // The first summary of a chapter has no row yet: its placeholder
          // sits where the card will be, just above the divider.
          const placeholder = summaryRun !== null && summaryRun.breakId === row.break.id
            && rows[index - 1]?.kind !== "chapter-summary";
          return (
            <Fragment key={row.id}>
              {placeholder && <SummaryCard chapter={row.closingChapter} summary={null} running />}
              <ChapterDivider storyId={payload.id} row={row} />
            </Fragment>
          );
        }
        return (
          <SummaryCard
            key={row.id}
            chapter={row.chapter}
            summary={row.summary}
            running={summaryRun !== null && summaryRun.breakId === row.chapter.closedBy?.id}
          />
        );
      })}
      {placement !== null && stops.at(-1)?.kind === "leaf" && (
        <PlacementGap stop={stops.at(-1)!} selected={pickedStop === stops.length - 1} />
      )}
      {summaryRun !== null && summaryRun.breakId === null && <SummaryTakeCard text={summaryRun.text} />}
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
