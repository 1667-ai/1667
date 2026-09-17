/** Keys sheet (D-05, §7): the TUI's own key reference, filtered to the
 * bindings the desktop registry actually runs, plus a DESKTOP section for
 * the desktop-only ⌘ chords. No QWERTY diagram — the TUI replaced that with
 * these sections on purpose (see the comment above `SECTIONS` in
 * `tui/src/keys-reference-model.ts`), and the desktop reads its wording
 * unchanged rather than hand-copying it. */
import { KEYS_MODAL_MODEL, type KeysModalEntry } from "../tui/src/keys-reference-model.js";
import { registryHasBinding } from "./renderer-commands.js";
import { el } from "./renderer-dom.js";
import type { RendererActions } from "./renderer-model.js";

const DESKTOP_CHORDS: readonly { readonly chord: string; readonly description: string }[] = [
  { chord: "⌘1–6", description: "jump to a destination" },
  { chord: "⌘,", description: "open Settings" },
  { chord: "⌘K", description: "open the command palette" },
  { chord: "⌘↵", description: "send from the composer" },
  { chord: "⌘S", description: "save the focused edit" }
];

function supportedEntries(entries: readonly KeysModalEntry[]): readonly KeysModalEntry[] {
  return entries.filter((entry) => entry.bindings.some((binding) => registryHasBinding(binding)));
}

function renderRow(token: string, description: string): HTMLElement {
  return el("div", "keys-sheet-row", el("span", "keys-sheet-keys", token), el("span", "keys-sheet-description", description));
}

export function renderKeysSheet(actions: RendererActions): HTMLElement {
  const outer = el("div", "popover keys-sheet");
  outer.setAttribute("role", "dialog");
  outer.setAttribute("aria-label", "Keyboard shortcuts");
  outer.addEventListener("click", (event) => { if (event.target === outer) actions.closePopover(); });
  const card = el("div", "popover-card keys-sheet-card");
  card.append(el("h2", "popover-title", "Keys · and what they do"));
  for (const section of KEYS_MODAL_MODEL.sections) {
    const entries = supportedEntries(section.entries);
    if (entries.length === 0) continue;
    const block = el("section", "keys-sheet-section");
    block.append(el("div", "keys-sheet-heading", el("span", "eyebrow", section.title), el("span", "keys-sheet-blurb", section.blurb)));
    for (const entry of entries) block.append(renderRow(entry.token, entry.description));
    card.append(block);
  }
  const desktopSection = el("section", "keys-sheet-section");
  desktopSection.append(el("div", "keys-sheet-heading", el("span", "eyebrow", "DESKTOP"), el("span", "keys-sheet-blurb", "this window only")));
  for (const item of DESKTOP_CHORDS) desktopSection.append(renderRow(item.chord, item.description));
  card.append(desktopSection);
  card.append(el("p", "keys-sheet-footer", "letters act when no field has focus · esc peels one layer"));
  outer.append(card);
  return outer;
}
