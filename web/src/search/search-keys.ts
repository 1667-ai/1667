import {
  resolveReferenceBinding,
  type ReferenceBinding,
  type ReferenceBindingLane
} from "../../../shared/reference-bindings.js";
import { keyEventFromDom } from "../app/keymap-dom.js";

/** The key actions the search dialog handles. `app/keymap.ts` opens it with
 * `open-search`; keys help lists only the actions named here. */
export const SEARCH_KEY_ACTIONS: readonly string[] = [
  "open-search",
  "cancel",
  "focus-previous",
  "focus-next",
  "take-previous",
  "take-next",
  "cycle",
  "apply",
  "toggle-search-case"
];

const SEARCH_LANES: readonly ReferenceBindingLane[] = ["global", "search"];

/** The TUI's SEARCH keys, read from the same table. ⌘ and ⌥ never resolve. */
export function resolveSearchBinding(event: KeyboardEvent): ReferenceBinding | null {
  if (event.metaKey || event.altKey) return null;
  const key = keyEventFromDom(event);
  for (const lane of SEARCH_LANES) {
    const binding = resolveReferenceBinding(lane, key, "SEARCH");
    if (binding !== null) return binding;
  }
  return null;
}
