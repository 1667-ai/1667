import { type HitRows } from "../hit.js";
import type { AppMode, KeyAction } from "../keys.js";
import type { MapView } from "../map-state.js";
import { panelWidthFor, placePanel, raisedSegment } from "./overlay.js";
import { VERSION_TAG } from "./story/status.js";
import { truncate, visibleWidth, type DisplayRole, type FrameComposition, type FrameLine } from "./story/frame.js";

export interface KeysModalBinding {
  name: string;
  mode: AppMode;
  action: KeyAction;
  sequence?: string;
  shift?: boolean;
  ctrl?: boolean;
  mapView?: MapView;
}

/** One row of the reference: the keys as a writer would spell them, and what
 *  pressing them does. Every row carries the bindings it claims, so the
 *  resolver-contract tests fail rather than let the copy drift from reality. */
export interface KeysModalEntry {
  token: string;
  description: string;
  bindings: readonly KeysModalBinding[];
}

export interface KeysModalSection {
  title: string;
  blurb: string;
  role: DisplayRole;
  entries: readonly KeysModalEntry[];
}

export interface KeysModalModel {
  sections: readonly KeysModalSection[];
  bindings: readonly KeysModalBinding[];
}

const binding = (
  name: string,
  mode: AppMode,
  action: KeyAction,
  extra: Partial<KeysModalBinding> = {}
): KeysModalBinding => ({ name, mode, action, ...extra });

const entry = (
  token: string,
  description: string,
  bindings: readonly KeysModalBinding[]
): KeysModalEntry => ({ token, description, bindings });

/** The whole key reference, as sections a writer can read top to bottom.
 *
 * This replaced a QWERTY diagram that coloured caps by band and left most of
 * them unexplained: it cost eight rows and half the panel width to say where
 * `r` sits on the keyboard, which is the one thing nobody needs told. Every
 * key that does something now states what it does, in the same voice as the
 * command palette.
 *
 * Descriptions stay within DESCRIPTION_BUDGET cells so two columns fit an
 * 80-column terminal without truncation; keep new copy inside it. */
const SECTIONS: readonly KeysModalSection[] = [
  {
    title: "MOVE",
    blurb: "read and navigate",
    role: "focus / accent",
    entries: [
      entry("↑ ↓", "move between parts", [
        binding("up", "NAV", "focus-previous"),
        binding("down", "NAV", "focus-next"),
        binding("up", "MAP", "focus-previous", { mapView: "path" }),
        binding("down", "MAP", "focus-next", { mapView: "path" }),
        binding("up", "MAP", "focus-previous", { mapView: "tree" }),
        binding("down", "MAP", "focus-next", { mapView: "tree" }),
        binding("up", "MAP", "focus-previous", { mapView: "mass" }),
        binding("down", "MAP", "focus-next", { mapView: "mass" })
      ]),
      entry("← →", "flip between takes", [
        binding("left", "NAV", "take-previous"),
        binding("right", "NAV", "take-next"),
        binding("left", "MAP", "take-previous", { mapView: "path" }),
        binding("right", "MAP", "take-next", { mapView: "path" })
      ]),
      entry("⇧↑ ⇧↓", "nudge the page a line", [
        binding("up", "NAV", "scroll-line-up", { shift: true }),
        binding("down", "NAV", "scroll-line-down", { shift: true })
      ]),
      entry("⌃u ⌃d", "page up and down", [
        binding("u", "NAV", "scroll-up", { ctrl: true }),
        binding("d", "NAV", "scroll-down", { ctrl: true })
      ]),
      entry("g / G", "first part · newest leaf", [
        binding("g", "NAV", "top"),
        binding("G", "NAV", "leaf", { shift: true })
      ]),
      entry("[ ]", "chapter back · forward", [
        binding("[", "NAV", "chapter-previous"),
        binding("]", "NAV", "chapter-next")
      ]),
      entry("u", "undo the last change", [binding("u", "NAV", "undo")])
    ]
  },
  {
    title: "WRITE",
    blurb: "make the next part",
    role: "human edit",
    entries: [
      entry("space", "continue this part", [binding("space", "NAV", "continue")]),
      entry("enter i", "type what happens next", [
        binding("return", "NAV", "compose"),
        binding("i", "NAV", "compose")
      ]),
      entry("r", "retake · same prompt", [binding("r", "NAV", "regenerate")]),
      entry("R", "retake · edit prompt", [
        binding("R", "NAV", "retake-with-prompt", { shift: true })
      ]),
      entry("w", "write a take yourself", [binding("w", "NAV", "write")]),
      entry("e", "edit prose and prompt", [binding("e", "NAV", "edit")]),
      entry("y / Y", "copy part · whole line", [
        binding("y", "NAV", "copy-part"),
        binding("Y", "NAV", "copy-line", { shift: true })
      ]),
      entry("⌃↑ ⌃↓", "past prompts, in direct", [
        binding("up", "COMPOSE", "history-previous", { ctrl: true }),
        binding("down", "COMPOSE", "history-next", { ctrl: true })
      ]),
      entry("n", "start a new story", [binding("n", "NAV", "new-item")])
    ]
  },
  {
    title: "SHAPE",
    blurb: "arrange what exists",
    role: "bookmark · alt",
    entries: [
      entry("d", "delete take and below", [binding("d", "NAV", "prune")]),
      entry("b", "bookmark the line here", [binding("b", "NAV", "bookmark")]),
      entry("c / C", "chapters · end one here", [
        binding("c", "NAV", "open-chapters"),
        binding("C", "NAV", "create-chapter", { shift: true })
      ]),
      entry("x", "actions for this part", [binding("x", "NAV", "open-actions")]),
      entry("p", "show or hide directions", [binding("p", "NAV", "toggle-instructions")]),
      entry("z", "typewriter mode", [binding("z", "NAV", "typewriter")]),
      entry("F", "facts rail on or off", [
        binding("F", "NAV", "toggle-rail", { shift: true })
      ])
    ]
  },
  {
    title: "OPEN",
    blurb: "panels and views",
    role: "bookmark · canon",
    entries: [
      entry("m", "map of the whole story", [binding("m", "NAV", "open-map")]),
      entry("f", "facts kept for context", [binding("f", "NAV", "open-facts")]),
      entry("o", "switch story · library", [binding("o", "NAV", "open-library")]),
      entry(": ⌃p", "command palette", [
        binding(":", "NAV", "open-commands"),
        binding("p", "NAV", "open-commands", { ctrl: true })
      ]),
      entry(",", "generation settings", [binding(",", "NAV", "open-settings")]),
      entry("⌃g", "context meter details", [
        binding("g", "NAV", "toggle-context-meter", { ctrl: true }),
        binding("g", "COMPOSE", "toggle-context-meter", { ctrl: true })
      ]),
      entry("?", "this key reference", [binding("?", "NAV", "open-keys")]),
      entry("esc", "close what is open", [binding("escape", "KEYS", "cancel")]),
      entry("q", "quit 1667", [binding("q", "NAV", "quit")])
    ]
  },
  {
    title: "MAP",
    blurb: "while the map is open",
    role: "compose accent",
    entries: [
      entry("m", "cycle path · tree · mass", [binding("m", "MAP", "cycle-map-view")]),
      entry("a", "all takes · sketches", [
        binding("a", "MAP", "toggle-path-takes", { mapView: "path" }),
        binding("a", "MAP", "toggle-sketches", { mapView: "tree" }),
        binding("a", "MAP", "toggle-sketches", { mapView: "mass" })
      ]),
      entry("s", "sort by mass", [
        binding("s", "MAP", "map-cycle-sort", { mapView: "tree" }),
        binding("s", "MAP", "map-cycle-sort", { mapView: "mass" })
      ]),
      entry("l", "follow into the story", [
        binding("l", "MAP", "map-follow", { mapView: "tree" }),
        binding("l", "MAP", "map-follow", { mapView: "mass" })
      ]),
      entry("enter", "jump to that part", [binding("return", "MAP", "apply")]),
      entry("d / b", "prune · bookmark here", [
        binding("d", "MAP", "prune", { mapView: "path" }),
        binding("b", "MAP", "bookmark", { mapView: "path" })
      ])
    ]
  }
];

export const KEYS_MODAL_MODEL: KeysModalModel = {
  sections: SECTIONS,
  bindings: SECTIONS.flatMap((section) => section.entries.flatMap((item) => item.bindings))
};

/** Copy budget, not a measurement of the copy: exceeding it truncates rather
 *  than reflowing, so the panel geometry cannot be widened by a long line. */
const DESCRIPTION_BUDGET = 24;
/** Headings share the key column, so they widen it as an entry token would. */
const TOKEN_WIDTH = Math.max(...SECTIONS.flatMap((section) => [
  visibleWidth(heading(section)),
  ...section.entries.map((item) => visibleWidth(item.token))
]));
const COLUMN_WIDTH = TOKEN_WIDTH + 2 + DESCRIPTION_BUDGET;
const COLUMN_GUTTER = 2;
const MAX_COLUMNS = 3;
const PANEL_MAX_WIDTH = MAX_COLUMNS * COLUMN_WIDTH + (MAX_COLUMNS - 1) * COLUMN_GUTTER + 2;
/** Panel chrome placePanel adds around the content rows it will actually draw:
 *  title, blank, border, footer, and the row the frame reserves below. */
const PANEL_CHROME_ROWS = 9;

export interface KeysOverlayRender {
  composition: FrameComposition;
  /** Scroll offset after clamping, for the caller to store back. */
  scrollTop: number;
}

export function renderKeysOverlay(
  base: FrameLine[],
  hits: HitRows,
  width: number,
  height: number,
  scrollTop = 0
): KeysOverlayRender {
  const panelWidth = panelWidthFor(width, PANEL_MAX_WIDTH);
  const interior = panelWidth - visibleWidth("┃ ");
  const columns = columnCount(interior);
  const rows = layoutRows(interior, columns);
  const visibleRows = Math.max(3, height - PANEL_CHROME_ROWS);
  const maxScroll = Math.max(0, rows.length - visibleRows);
  const top = Math.max(0, Math.min(scrollTop, maxScroll));
  const content = rows.slice(top, top + visibleRows);
  const clipped = maxScroll > 0;
  // The status bar hides its build tag on a narrow terminal, so the reference
  // is where `1667 v…` is always reachable.
  const footer = `1667 ${VERSION_TAG} · ${clipped
    ? `↑↓ scrolls · ${top + content.length} of ${rows.length} rows · esc closes`
    : "drag selects · ctrl+c copies · esc closes"}`;

  // Inert, not transparent: without hits the story's own rows stay live under
  // the modal, so a click outside would not even dismiss it.
  return {
    composition: placePanel(
      base,
      "keys · what every key does",
      content,
      footer,
      width,
      height,
      PANEL_MAX_WIDTH,
      { rows: hits, targets: content.map(() => null) }
    ),
    scrollTop: top
  };
}

function columnCount(interior: number): number {
  const fits = Math.floor((interior + COLUMN_GUTTER) / (COLUMN_WIDTH + COLUMN_GUTTER));
  return Math.max(1, Math.min(MAX_COLUMNS, fits));
}

/** Sections become blocks, blocks are dealt into columns, and the columns are
 *  zipped back into rows the panel can draw. Dealing whole sections keeps a
 *  heading with its keys; the scroll offset then applies to every column at
 *  once, so a clipped panel reads as one table rather than five. */
function layoutRows(interior: number, columns: number): FrameLine[] {
  const cellWidth = columns === 1
    ? interior
    : Math.min(COLUMN_WIDTH, Math.floor((interior - COLUMN_GUTTER * (columns - 1)) / columns));
  const blocks = SECTIONS.map((section) => sectionLines(section, cellWidth));
  const strips = dealColumns(blocks, columns);
  const tallest = Math.max(...strips.map((strip) => strip.length));
  const rows: FrameLine[] = [];
  for (let row = 0; row < tallest; row += 1) {
    const line: FrameLine = [];
    for (const [index, strip] of strips.entries()) {
      if (index > 0) line.push(raisedSegment(" ".repeat(COLUMN_GUTTER), "chrome"));
      const cell = strip[row] ?? [];
      line.push(...cell, raisedSegment(" ".repeat(Math.max(0, cellWidth - lineWidth(cell))), "chrome"));
    }
    rows.push(line);
  }
  return rows;
}

function sectionLines(section: KeysModalSection, cellWidth: number): FrameLine[] {
  // The heading sits in the key column so its blurb starts where the
  // descriptions do: two aligned columns per cell, not a ragged third edge.
  return [
    fitCell([
      { ...raisedSegment(padKey(heading(section)), section.role), bold: true },
      raisedSegment(`  ${section.blurb}`, "prose · dim")
    ], cellWidth),
    ...section.entries.map((item) => fitCell([
      raisedSegment(padKey(item.token), section.role),
      raisedSegment(`  ${item.description}`, "prose · dim")
    ], cellWidth))
  ];
}

function heading(section: KeysModalSection): string {
  return `● ${section.title}`;
}

/** Right-align in the key column by cells; `padStart` counts code units. */
function padKey(token: string): string {
  return " ".repeat(Math.max(0, TOKEN_WIDTH - visibleWidth(token))) + token;
}

/** Clip a cell to its column. The token keeps its cells and the description
 *  yields them: a truncated `⇧↑ ⇧↓` would name a key nobody can press. */
function fitCell(line: FrameLine, cellWidth: number): FrameLine {
  if (lineWidth(line) <= cellWidth) return line;
  const [head, ...rest] = line;
  const headWidth = head === undefined ? 0 : visibleWidth(head.text);
  const budget = Math.max(0, cellWidth - headWidth);
  const clipped: FrameLine = head === undefined ? [] : [head];
  let used = 0;
  for (const part of rest) {
    const text = truncate(part.text, budget - used);
    if (text.length > 0) clipped.push({ ...part, text });
    used += visibleWidth(text);
  }
  return clipped;
}

/** Contiguous partition that minimises the tallest column: the first height
 *  that greedy packing can meet with the columns available. */
function dealColumns(blocks: readonly FrameLine[][], columns: number): FrameLine[][] {
  const heights = blocks.map((block) => block.length);
  const total = heights.reduce((sum, value) => sum + value, 0) + blocks.length - 1;
  for (let limit = Math.max(...heights); limit <= total; limit += 1) {
    const groups = packWithin(heights, limit);
    if (groups !== null && groups.length <= columns) {
      return groups.map((group) => group.flatMap((index, position) =>
        position === 0 ? blocks[index]! : [[], ...blocks[index]!]));
    }
  }
  return [blocks.flatMap((block, index) => index === 0 ? block : [[], ...block])];
}

/** Greedy grouping under a height limit; null when one block alone exceeds it. */
function packWithin(heights: readonly number[], limit: number): number[][] | null {
  const groups: number[][] = [];
  let current: number[] = [];
  let used = 0;
  for (const [index, height] of heights.entries()) {
    if (height > limit) return null;
    const cost = current.length === 0 ? height : height + 1;
    if (used + cost > limit) {
      groups.push(current);
      current = [index];
      used = height;
      continue;
    }
    current.push(index);
    used += cost;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function lineWidth(line: FrameLine): number {
  return line.reduce((sum, part) => sum + visibleWidth(part.text), 0);
}
