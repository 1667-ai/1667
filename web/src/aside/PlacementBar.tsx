import { useEffect, useRef } from "react";
import type { ReferenceBinding } from "../../../shared/reference-bindings.js";
import { useAppContext } from "../app/context.js";
import { activatesOnEnterOrSpace } from "../app/keymap-dom.js";
import { pushKeyLayer } from "../app/keymap.js";
import { useStore } from "../app/store.js";
import { Icon, ICONS } from "../ui/icons.js";
import { stopLabel, type PlacementStop } from "./placement.js";

/** A key of the choice, in the shape the key layers hand around. */
function binding(action: string, name: string): ReferenceBinding {
  return { display: name, lane: "nav", name, mode: "NAV", action } as ReferenceBinding;
}

/**
 * The bar above the manuscript while the writer picks where an Aside answer
 * goes. It owns the keys of the choice on a key layer: ↑↓ move, Enter inserts,
 * Esc cancels. Nothing is written until Insert.
 */
export function PlacementBanner({ storyId }: { readonly storyId: string }) {
  const { store, actions } = useAppContext();
  const active = useStore(store, (state) => state.aside.placement?.storyId === storyId);
  const placing = useStore(store, (state) => state.aside.placement?.placing === true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    // The keyboard is on the banner, not on a button: Enter must reach the layer.
    ref.current?.focus();
    return pushKeyLayer({
      claimsEscape: true,
      resolve: (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return null;
        if (event.key === "ArrowDown") return binding("focus-next", "down");
        if (event.key === "ArrowUp") return binding("focus-previous", "up");
        if (event.key === "Enter") return binding("apply", "return");
        if (event.key === "Escape") return binding("cancel", "escape");
        return null;
      },
      handle: (key) => {
        if (key.action === "apply" && activatesOnEnterOrSpace()) return false;
        if (key.action === "focus-next") actions.aside.movePlacement(1);
        else if (key.action === "focus-previous") actions.aside.movePlacement(-1);
        else if (key.action === "apply") void actions.aside.confirmPlacement();
        else actions.aside.cancelPlacement();
        return true;
      }
    });
  }, [active, actions]);

  if (!active) return null;
  return (
    <div className="placement-banner" role="region" aria-label="Insert the Aside answer" tabIndex={-1} ref={ref}>
      <span className="placement-banner-text">Choose where the answer goes. Nothing is written until you insert.</span>
      <span className="placement-banner-actions">
        <button type="button" className="btn btn-small btn-ghost" title="Cancel (Esc)" disabled={placing} onClick={actions.aside.cancelPlacement}>
          Cancel
        </button>
        <button type="button" className="btn btn-small btn-primary" title="Insert here (Enter)" disabled={placing} onClick={() => void actions.aside.confirmPlacement()}>
          {placing ? "Inserting…" : "Insert"}
        </button>
      </span>
    </div>
  );
}

/** One "Insert here" target between parts (or after the leaf). A click picks it. */
export function PlacementGap({ stop, selected }: { readonly stop: PlacementStop; readonly selected: boolean }) {
  const { actions } = useAppContext();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const pick = stop.kind === "take" ? { kind: "take" as const, partId: stop.partId } : { kind: "leaf" as const };
  return (
    <li className="placement-gap">
      <button
        type="button"
        ref={ref}
        className="placement-target"
        aria-pressed={selected}
        title={`${stopLabel(stop)} (↑↓ move, Enter inserts)`}
        onClick={() => {
          actions.aside.pickPlacement(pick);
          // The keyboard goes back to the banner, so Enter inserts.
          document.querySelector<HTMLElement>(".placement-banner")?.focus();
        }}
      >
        <Icon path={ICONS.plus} />
        Insert here
        <span className="placement-target-meta">{stopLabel(stop)}</span>
      </button>
    </li>
  );
}
