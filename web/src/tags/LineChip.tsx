import { useCallback, useEffect, useRef } from "react";
import { lineName } from "../../../shared/story-model.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { focusCurrentPart } from "../story/focus-dom.js";
import { Icon, ICONS } from "../ui/icons.js";
import { usePopover } from "../ui/usePopover.js";
import { StatusChip } from "./StatusChip.js";
import { registerPreload } from "../app/preload.js";
import { lazyView } from "../ui/LazyView.js";

// The popover loads when it is first opened.
const TagPopover = lazyView(async () => (await import("./TagPopover.js")).TagPopover, { floating: true });
registerPreload("tag-popover", () => TagPopover.preload());
import { tagOf } from "./state.js";

/**
 * The story header's line chip (#409 step 7a): the line's name, with its
 * status when it is tagged, as one button that opens the tag popover. `t`
 * opens the same popover from the keyboard, so its open state lives in the
 * store.
 */
export function LineChip({ payload }: { readonly payload: StoryPayload }) {
  const { store, actions } = useAppContext();
  const open = useStore(store, (state) => (
    state.tags.open !== null && state.tags.open.storyId === payload.id ? state.tags.open : null
  ));
  const setOpen = useCallback(
    (next: boolean) => (next ? actions.tags.openForLine() : actions.tags.close()),
    [actions]
  );
  const popover = usePopover({ open: open !== null, setOpen });
  const chipRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<"chip" | "part" | "map">("chip");
  if (open !== null) returnTo.current = open.returnTo;
  const wasOpen = useRef(false);

  useEffect(() => {
    // Closing hands the keyboard back: to the chip when the chip opened it,
    // to the part when `t` or the part menu did.
    if (wasOpen.current && open === null) {
      if (returnTo.current === "chip") chipRef.current?.focus();
      else focusCurrentPart();
    }
    wasOpen.current = open !== null;
  }, [open]);

  const leaf = payload.path.at(-1);
  if (leaf === undefined) return null;
  const tag = tagOf(payload, leaf.id);

  return (
    <div className="line-chip-wrap" ref={popover.containerRef}>
      <button
        type="button"
        ref={chipRef}
        className="line-chip"
        title="Tag line (t)"
        aria-label="Tag line (t)"
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        onClick={() => setOpen(open === null)}
      >
        <Icon path={ICONS.flag} />
        <span className="line-chip-name">{lineName(payload, leaf.id)}</span>
        {tag !== null && <StatusChip status={tag.status} />}
      </button>
      {open !== null && <TagPopover payload={payload} target={open} />}
    </div>
  );
}
