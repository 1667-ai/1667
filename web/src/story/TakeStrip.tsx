import { takeStripCells } from "../../../shared/take-strip.js";

export interface TakeStripProps {
  readonly siblingCount: number;
  /** 1-based; the optimistic target while a switch is in flight, the
   * server-confirmed take otherwise. */
  readonly currentTakeIndex: number;
  readonly takeSubtakes: readonly boolean[];
  readonly disabled: boolean;
  /** 1-based take position — `PartCard.tsx` resolves this to a sibling id
   * (it already has `payload`/`part.id` in scope; this component does not
   * need either). */
  readonly onSwitchToPosition: (position: number) => void;
}

/**
 * The same glyph ladder as the TUI's own take strip, sharing its pure
 * computation (`shared/take-strip.ts`'s `takeStripCells`), drawn as CSS dots
 * (`styles/takes.css`) — Decision 18: ● the
 * take being read (whether or not it branches — its own subtakes are the
 * parts below it already), ◎ a sibling that branches into subtakes of its
 * own, ○ a childless sibling. Past 12, individual dots stop being legible, so
 * a single-dot gauge shows position instead (`TakePeek.tsx`'s virtualized
 * list is what jumps to an arbitrary take in a line that long).
 */
export function TakeStrip({ siblingCount, currentTakeIndex, takeSubtakes, disabled, onSwitchToPosition }: TakeStripProps) {
  if (siblingCount <= 1) return null;
  const cells = takeStripCells(currentTakeIndex, siblingCount, takeSubtakes);

  if (cells.density === "gauge") {
    const percent = (cells.gaugeFraction ?? 0) * 100;
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
      {cells.glyphs.map((glyph, offset) => {
        const position = offset + 1;
        const isCurrent = position === currentTakeIndex;
        return (
          <button
            key={position}
            type="button"
            className={glyph === "◎" ? "take-dot branch" : "take-dot"}
            aria-current={isCurrent ? "true" : undefined}
            aria-label={`Take ${position} of ${siblingCount}`}
            title={`Take ${position} of ${siblingCount}`}
            disabled={disabled}
            onClick={() => onSwitchToPosition(position)}
          />
        );
      })}
    </span>
  );
}
