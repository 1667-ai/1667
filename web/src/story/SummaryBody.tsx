import type { HumanEditAttribution } from "../../../shared/types.js";
import { Prose } from "./Prose.js";

export interface SummaryBodyProps {
  readonly text: string;
  readonly humanEdit?: HumanEditAttribution | null;
  /** Extra class(es) the caller's own wrapper needs alongside
   * `part-summary-body` — `PartCard.tsx` nests this inside its own
   * `<article class="part">`, so it needs none; `Manuscript.tsx`'s
   * `ChapterSummaryCard` has no such wrapper, so it adds `"part"` itself. */
  readonly className?: string;
  readonly onMouseUp?: () => void;
}

/** A legacy reset-summary or chapter-summary take's body: shared by
 * `PartCard.tsx` (a legacy summary is still a `part` row) and
 * `Manuscript.tsx`'s `ChapterSummaryCard` (a chapter summary is its own row
 * kind, display only). */
export function SummaryBody({ text, humanEdit = null, className, onMouseUp }: SummaryBodyProps) {
  return (
    <div className={className === undefined ? "part-summary-body" : `${className} part-summary-body`} onMouseUp={onMouseUp}>
      <span className="summary-card-label">SUMMARY — THE MODEL READS THIS RECAP</span>
      <Prose text={text} humanEdit={humanEdit} />
      <span className="part-summary-note">
        A summary take starts fresh context. Everything above stays in the manuscript.
      </span>
    </div>
  );
}
