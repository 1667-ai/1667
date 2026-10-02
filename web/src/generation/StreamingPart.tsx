import { Prose } from "../story/Prose.js";

export interface StreamingPartProps {
  readonly partNumber: number;
  readonly instruction: string;
  readonly showDirections: boolean;
  readonly text: string;
  /** Reasoning has arrived and no prose yet — the "Thinking…" phase (owner
   * decision 5: an indicator only, never the thought text itself, never a
   * `T` toggle). */
  readonly thinking: boolean;
  /** False for a frozen `"unsaved"` leftover: the text still shows, but
   * nothing is still being written, so no caret. */
  readonly live: boolean;
}

/**
 * The virtual part a new take streams into — a `<PartCard>`-shaped row with
 * no take controls, no click-to-focus, and `aria-busy` in place of
 * `aria-current` (#409 step 5's `Manuscript` renders this in place of the
 * parts a new take's projected path hides, after `seamPathIndex`). An
 * append instead grows the existing leaf's own `PartCard` in place — see
 * its `continuation` prop — so this component only ever exists for
 * `mode: "take"`.
 */
export function StreamingPart({ partNumber, instruction, showDirections, text, thinking, live }: StreamingPartProps) {
  return (
    <li>
      <article
        className="part part-streaming"
        aria-busy={live ? "true" : undefined}
        aria-label={`Part ${partNumber}, ${live ? "writing" : "not saved"}`}
      >
        <div className="part-header">
          <span className="part-number">Part {partNumber}</span>
        </div>
        {showDirections && instruction.length > 0 && (
          <div className="part-instruction">{instruction}</div>
        )}
        {thinking
          ? <p className="generation-thinking">Thinking…</p>
          : <Prose text={text} caret={live} />}
      </article>
    </li>
  );
}
