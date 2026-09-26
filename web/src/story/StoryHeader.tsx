import { lineName } from "../../../shared/story-model.js";
import { countWords } from "../../../shared/story-text.js";
import type { StoryPayload } from "../../../shared/types.js";

export interface StoryHeaderProps {
  readonly payload: StoryPayload;
  readonly showDirections: boolean;
  readonly onToggleDirections: () => void;
}

/** Title, stats, and the "Show directions" toggle. Ported from
 * `~/source/storytavern/web/src/story.css`'s header rules
 * (`web/src/styles/story.css` already carries them, from step 3's
 * placeholder) — the title is a plain heading here, never an editable
 * field (that is write-side, later steps). */
export function StoryHeader({ payload, showDirections, onToggleDirections }: StoryHeaderProps) {
  const words = payload.path.reduce((total, node) => total + countWords(node.text), 0);
  const leafId = payload.path.at(-1)?.id ?? null;
  const line = leafId === null ? null : lineName(payload, leafId);

  return (
    <header className="story-header">
      <div className="story-identity">
        {line !== null && <span className="story-kicker">{line}</span>}
        <div className="story-title-wrap">
          <h1 className="story-title">{payload.title}</h1>
        </div>
        <span className="story-stats">
          {payload.path.length} {payload.path.length === 1 ? "part" : "parts"} ·{" "}
          {words.toLocaleString()} words
        </span>
      </div>
      <div className="story-actions">
        <button
          type="button"
          className="btn btn-ghost btn-small"
          aria-pressed={showDirections}
          onClick={onToggleDirections}
        >
          Show directions
        </button>
      </div>
    </header>
  );
}
