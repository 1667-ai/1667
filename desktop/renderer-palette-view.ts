/** Command palette (D-43, §8): every verb whose `available(ctx)` is true,
 * grouped and filtered by a case-insensitive subsequence match on the label.
 * `⌘K` / `:` / `⌃p` / the titlebar chip open it unfiltered; `x` opens it
 * pre-filtered to Take. */
import { REFERENCE_BINDINGS } from "../tui/src/reference-bindings.js";
import { buildDesktopCommandContext, COMMANDS, type DesktopCommand } from "./renderer-commands.js";
import { el } from "./renderer-dom.js";
import type { DesktopCommandGroup, RendererActions, RendererState } from "./renderer-model.js";

const GROUP_ORDER: readonly DesktopCommandGroup[] = ["Story", "Take", "Facts", "Chapters", "Map", "Project", "Desktop"];

/** How loose a subsequence match may be before it is not a match at all:
 * the tightest window may not outrun the query by more than this many extra
 * characters. Groups are shown in a fixed order (Story before Take, …), so
 * an ungated loose match in an earlier group would outrank a tight match in
 * a later one — "Import Markdown, NovelAI, or SillyTavern" contains "reta"
 * spread across three words, and that must not beat "Retake this part". */
const MAX_MATCH_SLACK = 6;

/** The minimum-length window of `label` that contains `query` as a
 * case-insensitive subsequence, as the indices it matched, or `null` when no
 * window exists or the tightest one is looser than `MAX_MATCH_SLACK` allows.
 * A single greedy left-to-right scan finds *a* match, but the earliest one
 * can span the whole label; the standard two-pass fix scans forward for the
 * earliest possible end, then backward from there for the latest possible
 * start — together the tightest window ending at that point, which is
 * provably the tightest window overall. */
function subsequenceIndices(label: string, query: string): number[] | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const lowerLabel = label.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  let end = -1;
  let cursor = 0;
  for (const char of lowerQuery) {
    const found = lowerLabel.indexOf(char, cursor);
    if (found === -1) return null;
    end = found;
    cursor = found + 1;
  }
  const indices: number[] = new Array(lowerQuery.length);
  let position = end;
  for (let i = lowerQuery.length - 1; i >= 0; i -= 1) {
    while (lowerLabel[position] !== lowerQuery[i]) position -= 1;
    indices[i] = position;
    position -= 1;
  }
  return matchSpan(indices) > lowerQuery.length + MAX_MATCH_SLACK ? null : indices;
}

function matchSpan(indices: readonly number[]): number {
  return indices.length === 0 ? 0 : indices[indices.length - 1]! - indices[0]! + 1;
}

function highlightLabel(label: string, indices: readonly number[]): HTMLElement {
  const span = el("span", "palette-label");
  const hit = new Set(indices);
  let run = "";
  let runIsHit = false;
  const flush = (): void => {
    if (run.length === 0) return;
    span.append(runIsHit ? el("mark", "", run) : document.createTextNode(run));
    run = "";
  };
  for (let index = 0; index < label.length; index += 1) {
    const isHit = hit.has(index);
    if (index > 0 && isHit !== runIsHit) flush();
    runIsHit = isHit;
    run += label[index];
  }
  flush();
  return span;
}

export function commandKeyDisplay(command: DesktopCommand): string {
  if (command.binding !== undefined) return REFERENCE_BINDINGS[command.binding].display;
  return command.chord ?? "";
}

function selectPaletteRow(rows: readonly HTMLElement[], index: number): void {
  rows.forEach((row, position) => row.classList.toggle("selected", position === index));
  rows[index]?.scrollIntoView({ block: "nearest" });
}

export function renderPalette(state: RendererState, actions: RendererActions, focusInitial: boolean): HTMLElement {
  const popoverState = state.popover;
  const query = popoverState?.kind === "palette" ? popoverState.query : "";
  const groupFilter = popoverState?.kind === "palette" ? popoverState.group : null;
  const ctx = buildDesktopCommandContext(state, actions, null);

  const outer = el("div", "popover palette");
  outer.setAttribute("role", "dialog");
  outer.setAttribute("aria-label", "Command palette");
  outer.addEventListener("click", (event) => { if (event.target === outer) actions.closePopover(); });
  const card = el("div", "popover-card palette-card");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "palette-input";
  input.placeholder = groupFilter === null ? "Type a command…" : `Type a command… (${groupFilter})`;
  input.dataset.preserve = "palette";
  input.setAttribute("aria-label", "Command palette query");
  input.value = query;
  input.addEventListener("input", () => actions.setPaletteQuery(input.value));

  const list = el("div", "palette-list");
  let firstRow: HTMLButtonElement | null = null;
  for (const group of GROUP_ORDER) {
    if (groupFilter !== null && group !== groupFilter) continue;
    const matches = COMMANDS
      .filter((command) => command.group === group && command.hideFromPalette !== true && command.available(ctx))
      .map((command) => ({ command, indices: subsequenceIndices(command.label, query) }))
      .filter((entry): entry is { command: DesktopCommand; indices: number[] } => entry.indices !== null)
      // Tightest match first; a stable sort keeps the registry's own order
      // (roughly "most fundamental first") for ties, including the empty
      // query, where every command ties at span 0.
      .sort((a, b) => matchSpan(a.indices) - matchSpan(b.indices));
    if (matches.length === 0) continue;
    list.append(el("div", "palette-group-heading", group));
    for (const { command, indices } of matches) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "palette-row";
      row.dataset.preserve = `palette-row:${command.id}`;
      row.append(highlightLabel(command.label, indices), el("span", "palette-key", commandKeyDisplay(command)));
      row.addEventListener("click", () => {
        actions.closePopover();
        command.run(ctx);
      });
      if (firstRow === null) {
        firstRow = row;
        row.classList.add("selected");
      }
      list.append(row);
    }
  }
  if (list.childElementCount === 0) list.append(el("p", "empty-copy", "No matching commands."));

  input.addEventListener("keydown", (event) => {
    const rows = [...list.querySelectorAll<HTMLButtonElement>(".palette-row")];
    if (rows.length === 0) return;
    const currentIndex = rows.findIndex((row) => row.classList.contains("selected"));
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectPaletteRow(rows, currentIndex < 0 ? 0 : Math.min(currentIndex + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectPaletteRow(rows, currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      rows[currentIndex < 0 ? 0 : currentIndex]?.click();
    }
  });

  card.append(el("h2", "popover-title", "Commands"), input, list);
  outer.append(card);
  if (focusInitial) queueMicrotask(() => input.focus());
  return outer;
}
