import { KEYS_MODAL_MODEL } from "../../../shared/keys-reference-model.js";
import type { ReferenceBinding } from "../../../shared/reference-bindings.js";
import { isBrowserReservedBinding } from "../app/keymap-dom.js";
import { IS_MAC } from "../app/platform.js";
import { COMPOSE_KEY_ACTIONS } from "../compose/keys.js";
import { MAP_KEY_ACTIONS } from "../map/map-keys.js";
import { READING_KEY_ACTIONS } from "../story/reading-keys.js";
import { STRUCTURE_KEY_ACTIONS } from "../story/structure-keys.js";
import { WRITING_KEY_ACTIONS } from "../story/writing-keys.js";
import { SEARCH_KEY_ACTIONS } from "../search/search-keys.js";
import { OVERLAY_KEY_ACTIONS } from "./overlay-keys.js";

const NAV_ACTIONS: ReadonlySet<string> = new Set([
  ...READING_KEY_ACTIONS,
  ...WRITING_KEY_ACTIONS,
  ...STRUCTURE_KEY_ACTIONS,
  ...OVERLAY_KEY_ACTIONS,
  "open-search"
]);
const SEARCH_ACTIONS: ReadonlySet<string> = new Set(SEARCH_KEY_ACTIONS);
const MAP_ACTIONS: ReadonlySet<string> = new Set([...MAP_KEY_ACTIONS, "open-log"]);
const COMPOSE_ACTIONS: ReadonlySet<string> = new Set(COMPOSE_KEY_ACTIONS);

/** True when the web acts on this table row. Keys help lists only these, so it
 * never shows a key that does nothing here. The web leaves ⌃U, ⌃D and ⌃P to
 * the browser. */
export function webHandles(binding: ReferenceBinding): boolean {
  if (isBrowserReservedBinding(binding)) return false;
  switch (binding.mode) {
    case "NAV": return NAV_ACTIONS.has(binding.action);
    case "MAP": return MAP_ACTIONS.has(binding.action);
    case "COMPOSE": return COMPOSE_ACTIONS.has(binding.action);
    case "SEARCH": return SEARCH_ACTIONS.has(binding.action);
    case "KEYS":
    case "LOG": return binding.action === "cancel";
    default: return false;
  }
}

/** A key as this platform writes it: a chord is ⌃ on a Mac and `Ctrl+` elsewhere. */
export function keyLabel(binding: ReferenceBinding, isMac: boolean = IS_MAC): string {
  if (binding.ctrl !== true || isMac) return binding.display;
  return `Ctrl+${binding.display.replace(/^⌃/, "")}`;
}

export interface KeysHelpRow {
  readonly keys: string;
  readonly description: string;
}

export interface KeysHelpSection {
  readonly title: string;
  readonly blurb: string;
  readonly rows: readonly KeysHelpRow[];
}

/** The TUI's key reference (`shared/keys-reference-model.ts`), cut down to what the web handles. */
export function keysHelpSections(isMac: boolean = IS_MAC): KeysHelpSection[] {
  const sections: KeysHelpSection[] = [];
  for (const section of KEYS_MODAL_MODEL.sections) {
    const rows: KeysHelpRow[] = [];
    for (const entry of section.entries) {
      const bindings = entry.bindings.filter(webHandles);
      if (bindings.length === 0) continue;
      rows.push({
        keys: [...new Set(bindings.map((binding) => keyLabel(binding, isMac)))].join(" "),
        description: entry.description
      });
    }
    if (rows.length > 0) sections.push({ title: section.title, blurb: section.blurb, rows });
  }
  return sections;
}
