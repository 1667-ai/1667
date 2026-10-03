import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { anchoredStateCount } from "../facts/rows.js";
import { Icon, ICONS } from "../ui/icons.js";

/** The ◆ in a part's header when fact states start at it (#409 step 7c).
 * Clicking it opens Facts, narrowed to the facts with a state here. */
export function FactAnchorMark({ payload, partId }: { readonly payload: StoryPayload; readonly partId: string }) {
  const { actions } = useAppContext();
  const count = anchoredStateCount(payload, partId);
  if (count === 0) return null;
  const label = `${count} fact ${count === 1 ? "state" : "states"} here (f)`;
  return (
    <button
      type="button"
      className="fact-mark"
      title={label}
      aria-label={label}
      onClick={() => actions.facts.showAnchored(partId)}
    >
      <Icon path={ICONS.diamond} />
      {count}
    </button>
  );
}
