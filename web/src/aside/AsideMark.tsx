import type { StoryPart } from "../../../shared/manuscript-model.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { Icon, ICONS } from "../ui/icons.js";
import { presenceOfPart } from "./model.js";

/** The speech mark in a part's header when its take has Aside sessions, or
 * another take of the part has (then it is dimmed and says which). Clicking it
 * opens Aside on this take. */
export function AsideMark({ payload, part }: { readonly payload: StoryPayload; readonly part: StoryPart }) {
  const { actions } = useAppContext();
  const presence = presenceOfPart(payload, part);
  if (presence.here === 0 && presence.elsewhereTake === null) return null;
  const label = presence.here > 0
    ? `${presence.here} ${presence.here === 1 ? "aside" : "asides"} here (a)`
    : `Asides on take ${presence.elsewhereTake} (a)`;
  return (
    <button
      type="button"
      className={`aside-mark${presence.here === 0 ? " aside-mark-elsewhere" : ""}`}
      title={label}
      aria-label={label}
      onClick={() => actions.aside.open(part.id)}
    >
      <Icon path={ICONS.message} />
      {presence.here > 0 && presence.here}
    </button>
  );
}
