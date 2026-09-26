import { resolveTakeTarget } from "../../../shared/story-model.js";
import type { StoryPayload } from "../../../shared/types.js";

export interface TakeStripProps {
  readonly partId: string;
  readonly payload: StoryPayload;
  readonly siblingCount: number;
  /** 1-based; the optimistic target while a switch is in flight, the
   * server-confirmed take otherwise. */
  readonly currentTakeIndex: number;
  readonly takeSubtakes: readonly boolean[];
  readonly disabled: boolean;
  readonly onSwitchTo: (partId: string, targetId: string) => void;
}

/**
 * The same glyph ladder as the TUI's own take strip
 * (`tui/src/screens/story/density.ts`'s `takeStrip`): every take gets its
 * own dot up to 12 siblings — Decision 18: ● the take being read (whether or
 * not it branches — its own subtakes are the parts below it already), ◎ a
 * sibling that branches into subtakes of its own, ○ a childless sibling.
 * Past 12, individual dots stop being legible, so a single-dot gauge shows
 * position instead (`TakePeek.tsx`'s virtualized list is what jumps to an
 * arbitrary take in a line that long).
 */
export function TakeStrip({ partId, payload, siblingCount, currentTakeIndex, takeSubtakes, disabled, onSwitchTo }: TakeStripProps) {
  if (siblingCount <= 1) return null;

  const switchToPosition = (position: number): void => {
    const target = resolveTakeTarget(payload, partId, position);
    if (target !== null) onSwitchTo(partId, target.id);
  };

  if (siblingCount > 12) {
    const percent = ((currentTakeIndex - 1) / (siblingCount - 1)) * 100;
    return (
      <span
        className="take-gauge"
        role="img"
        aria-label={`Take ${currentTakeIndex} of ${siblingCount}`}
        title={`Take ${currentTakeIndex} of ${siblingCount}`}
      >
        <span className="take-gauge-track" aria-hidden="true">
          <span className="take-gauge-dot" style={{ left: `${percent}%` }} />
        </span>
      </span>
    );
  }

  return (
    <span className="take-dots" role="group" aria-label="Takes">
      {Array.from({ length: siblingCount }, (_, offset) => {
        const position = offset + 1;
        const isCurrent = position === currentTakeIndex;
        const glyph = isCurrent ? "●" : takeSubtakes[offset] === true ? "◎" : "○";
        return (
          <button
            key={position}
            type="button"
            className="take-dot"
            aria-current={isCurrent ? "true" : undefined}
            aria-label={`Take ${position} of ${siblingCount}`}
            disabled={disabled}
            onClick={() => switchToPosition(position)}
          >
            {glyph}
          </button>
        );
      })}
    </span>
  );
}
