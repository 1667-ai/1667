import { Prose } from "../story/Prose.js";
import { Icon, ICONS } from "../ui/icons.js";

/**
 * The summary take of the whole line while it is written (the palette's
 * "summary take"): a card at the end of the manuscript with the text as it
 * streams. The take is saved when the run is done; Stop drops it whole.
 */
export function SummaryTakeCard({ text }: { readonly text: string }) {
  return (
    <li className="summary-card summary-card-running" aria-busy="true">
      <div className="summary-card-head">
        <Icon path={ICONS.summary} />
        <span className="summary-card-title">Summarizing the story…</span>
        <span className="caret" aria-hidden="true" />
      </div>
      {text.trim().length > 0 && <div className="summary-card-streaming"><Prose text={text.trim()} /></div>}
    </li>
  );
}
