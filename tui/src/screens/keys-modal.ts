import { type HitRows } from "../hit.js";
import type { AppMode, KeyAction } from "../keys.js";
import type { MapView } from "../map-state.js";
import { AI_1667_VERSION_TAG } from "../../../shared/build-identity.js";
import { panelContentRows, panelWidthFor, placePanel, raisedSegment } from "./overlay.js";
import { boundedContent, panelRange } from "./panel-table-layout.js";
import { visibleWidth, type DisplayRole, type FrameComposition, type FrameLine } from "./story/frame.js";
import { wrapText } from "../wrap.js";

export interface KeysModalBinding {
  display: string;
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

type BindingOptions = Partial<Pick<
  KeysModalBinding,
  "sequence" | "shift" | "ctrl" | "mapView"
>>;

const binding = (
  name: string,
  mode: AppMode,
  action: KeyAction,
  extra: BindingOptions = {}
): KeysModalBinding => ({
  display: bindingDisplay(name, extra),
  name,
  mode,
  action,
  ...extra
});

const entry = (
  description: string,
  bindings: readonly KeysModalBinding[]
): KeysModalEntry => ({
  token: [...new Set(bindings.map((item) => item.display))].join(" "),
  description,
  bindings
});

function bindingDisplay(name: string, modifiers: BindingOptions): string {
  const base = modifiers.sequence ?? ({
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    pageup: "pgup",
    pagedown: "pgdn",
    return: "enter",
    escape: "esc"
  }[name] ?? name);
  if (modifiers.ctrl === true) return `⌃${base}`;
  if (modifiers.shift === true && ["up", "down", "left", "right"].includes(name)) {
    return `⇧${base}`;
  }
  return base;
}

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
      entry("previous · next row", [
        binding("up", "NAV", "focus-previous"),
        binding("down", "NAV", "focus-next"),
        binding("up", "MAP", "focus-previous", { mapView: "path" }),
        binding("down", "MAP", "focus-next", { mapView: "path" }),
        binding("up", "MAP", "focus-previous", { mapView: "tree" }),
        binding("down", "MAP", "focus-next", { mapView: "tree" }),
        binding("up", "MAP", "focus-previous", { mapView: "mass" }),
        binding("down", "MAP", "focus-next", { mapView: "mass" })
      ]),
      entry("flip between takes", [
        binding("left", "NAV", "take-previous"),
        binding("right", "NAV", "take-next"),
        binding("left", "MAP", "take-previous", { mapView: "path" }),
        binding("right", "MAP", "take-next", { mapView: "path" })
      ]),
      entry("nudge the page a line", [
        binding("up", "NAV", "scroll-line-up", { shift: true }),
        binding("down", "NAV", "scroll-line-down", { shift: true })
      ]),
      entry("page up", [
        binding("pageup", "NAV", "scroll-up"),
        binding("u", "NAV", "scroll-up", { ctrl: true })
      ]),
      entry("page down", [
        binding("pagedown", "NAV", "scroll-down"),
        binding("d", "NAV", "scroll-down", { ctrl: true })
      ]),
      entry("first part · line's leaf", [
        binding("g", "NAV", "top"),
        binding("G", "NAV", "leaf", { shift: true })
      ]),
      entry("chapter back · forward", [
        binding("[", "NAV", "chapter-previous"),
        binding("]", "NAV", "chapter-next")
      ]),
      // Undo consumes take switches and chapter breaks, and nothing else. It
      // must not read as a safety net beside `d`, which it cannot reverse.
      entry("undo take switch · break", [binding("u", "NAV", "undo")])
    ]
  },
  {
    title: "WRITE",
    blurb: "make the next part",
    role: "human edit",
    entries: [
      entry("continue this part", [binding("space", "NAV", "continue")]),
      entry("type what happens next", [
        binding("return", "NAV", "compose"),
        binding("i", "NAV", "compose")
      ]),
      entry("retake · same prompt", [binding("r", "NAV", "regenerate")]),
      entry("retake · edit prompt", [
        binding("R", "NAV", "retake-with-prompt", { shift: true })
      ]),
      entry("write a take yourself", [binding("w", "NAV", "write")]),
      entry("edit prose and prompt", [binding("e", "NAV", "edit")]),
      entry("copy part · whole line", [
        binding("y", "NAV", "copy-part"),
        binding("Y", "NAV", "copy-line", { shift: true })
      ]),
      entry("past prompts, in direct", [
        binding("up", "COMPOSE", "history-previous", { ctrl: true }),
        binding("down", "COMPOSE", "history-next", { ctrl: true })
      ]),
      entry("start a new story", [binding("n", "NAV", "new-item")])
    ]
  },
  {
    title: "SHAPE",
    blurb: "arrange what exists",
    role: "bookmark · alt",
    entries: [
      entry("delete take and below", [binding("d", "NAV", "prune")]),
      entry("bookmark the line here", [binding("b", "NAV", "bookmark")]),
      entry("chapters · end one here", [
        binding("c", "NAV", "open-chapters"),
        binding("C", "NAV", "create-chapter", { shift: true })
      ]),
      entry("actions for this part", [binding("x", "NAV", "open-actions")]),
      entry("show or hide directions", [binding("p", "NAV", "toggle-instructions")]),
      entry("typewriter mode", [binding("z", "NAV", "typewriter")]),
      entry("facts rail · auto or off", [
        binding("F", "NAV", "toggle-rail", { shift: true })
      ])
    ]
  },
  {
    title: "OPEN",
    blurb: "panels and views",
    role: "bookmark · canon",
    entries: [
      entry("map of the whole story", [binding("m", "NAV", "open-map")]),
      entry("facts kept for context", [binding("f", "NAV", "open-facts")]),
      entry("switch story · library", [binding("o", "NAV", "open-library")]),
      entry("command palette", [
        binding(":", "NAV", "open-commands"),
        binding("p", "NAV", "open-commands", { ctrl: true })
      ]),
      entry("generation settings", [binding(",", "NAV", "open-settings")]),
      entry("wide context details", [
        binding("g", "NAV", "toggle-context-meter", { ctrl: true }),
        binding("g", "COMPOSE", "toggle-context-meter", { ctrl: true })
      ]),
      entry("this key reference", [
        binding("?", "NAV", "open-keys"),
        binding("/", "NAV", "open-keys", { sequence: "?", shift: true })
      ]),
      entry("close what is open", [
        binding("escape", "NAV", "cancel"),
        binding("escape", "MAP", "cancel"),
        binding("escape", "KEYS", "cancel")
      ]),
      entry("quit 1667", [binding("q", "NAV", "quit")])
    ]
  },
  {
    title: "MAP",
    blurb: "while the map is open",
    role: "compose accent",
    entries: [
      entry("cycle path · tree · mass", [binding("m", "MAP", "cycle-map-view")]),
      entry("all takes · sketches", [
        binding("a", "MAP", "toggle-path-takes", { mapView: "path" }),
        binding("a", "MAP", "toggle-sketches", { mapView: "tree" }),
        binding("a", "MAP", "toggle-sketches", { mapView: "mass" })
      ]),
      entry("reroute node or sketch", [binding("return", "MAP", "apply")]),
      // Views the map itself names in its tabs. A key that does nothing in the
      // view you are looking at has to say so, or the reference lies again.
      entry("follow tree · open mass", [
        binding("l", "MAP", "map-follow", { mapView: "tree" }),
        binding("l", "MAP", "map-follow", { mapView: "mass" })
      ]),
      entry("tree→mass · mass sorts", [
        binding("s", "MAP", "map-cycle-sort", { mapView: "tree" }),
        binding("s", "MAP", "map-cycle-sort", { mapView: "mass" })
      ]),
      entry("prune · bookmark · path", [
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
  scrollTop = 0,
  buildIdentity = `1667 ${AI_1667_VERSION_TAG}`
): KeysOverlayRender {
  const panelWidth = panelWidthFor(width, PANEL_MAX_WIDTH);
  const interior = panelWidth - visibleWidth("┃ ");
  const columns = columnCount(interior);
  const footerCapacity = panelWidth - 4;
  const wrappedBuildIdentity = visibleWidth(buildIdentity) > footerCapacity;
  const rows = [
    ...layoutRows(interior, columns),
    ...(wrappedBuildIdentity
      ? [
          [],
          [{ ...raisedSegment("● BUILD", "brass dim"), bold: true }],
          ...wrapText(buildIdentity, [], interior)
            .map((line) => [raisedSegment(line.text, "prose · dim")])
        ]
      : [])
  ];
  // Slicing more than the panel will paint would leave rows behind a bound
  // that never reaches them, and make the title's range a lie.
  const visibleRows = panelContentRows(height);
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, rows.length - visibleRows)));
  const window = { start: top, end: Math.min(top + visibleRows, rows.length) };
  const content = rows.slice(window.start, window.end);
  const range = panelRange(rows.length, window);
  // The status bar hides its build tag on a narrow terminal, so the reference
  // is where `1667 v…` is always reachable.
  const footerCopy = range === ""
    ? "drag selects · ctrl+c copies · esc closes"
    : "↑↓ scrolls · esc closes";
  const expandedFooter = `${buildIdentity} · ${footerCopy}`;
  const compactFooter = visibleWidth(expandedFooter) > footerCapacity;
  const footer = !compactFooter
    ? expandedFooter
    : wrappedBuildIdentity
      ? "build ↓"
      : buildIdentity;
  // When the footer cannot carry scroll guidance, the short title keeps
  // overflow and the current position visible. It also protects tall, narrow
  // panels where no range exists but the explanatory title cannot fit.
  const expandedTitle = `keys · and what they do${range}`;
  const compactTitle = range === ""
    ? "?"
    : `? ↑↓${window.start + 1}/${rows.length}`;
  const title = (range !== "" && compactFooter)
    || visibleWidth(`┏━ ${expandedTitle} ━`) > panelWidth
    ? compactTitle
    : expandedTitle;

  // Inert, not transparent: without hits the story's own rows stay live under
  // the modal, so a click outside would not even dismiss it.
  return {
    composition: placePanel(
      base,
      title,
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
/** Chapter dividers and summaries answer to their own verbs — `e` renames a
 *  chapter, `d` removes its break — because `directChapterRowAction` runs
 *  before NAV. No static list can hold both meanings of a key, and the story
 *  already names the focused row's keys in the line beneath it, so the
 *  reference says where to look rather than guessing which row you are on. */
const CONTEXT_NOTE = "◦ chapter rows differ · the line under the story says how";

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
  rows.push([], ...wrapText(CONTEXT_NOTE, [], interior)
    .map((line) => [raisedSegment(line.text, "prose · dim")]));
  return rows;
}

function sectionLines(section: KeysModalSection, cellWidth: number): FrameLine[] {
  // The heading sits in the key column so its blurb starts where the
  // descriptions do: two aligned columns per cell, not a ragged third edge.
  if (cellWidth >= COLUMN_WIDTH) return boundedContent([
    [
      { ...raisedSegment(padKey(heading(section)), section.role), bold: true },
      raisedSegment(`  ${section.blurb}`, "prose · dim")
    ],
    ...section.entries.map((item) => [
      raisedSegment(padKey(item.token), section.role),
      raisedSegment(`  ${item.description}`, "prose · dim")
    ])
  ], cellWidth);
  return [
    ...compactRow(heading(section), section.blurb, section.role, cellWidth, true),
    ...section.entries.flatMap((item) =>
      compactRow(item.token, item.description, section.role, cellWidth, false))
  ];
}

const MIN_INLINE_DESCRIPTION_WIDTH = 12;

/** Narrow terminals keep every meaning by wrapping it. Below the width where
 * the aligned key gutter would starve the copy, the key and meaning stack. */
function compactRow(
  token: string,
  description: string,
  role: DisplayRole,
  width: number,
  bold: boolean
): FrameLine[] {
  const inlineMeasure = width - TOKEN_WIDTH - 2;
  if (inlineMeasure >= MIN_INLINE_DESCRIPTION_WIDTH) {
    return wrapText(description, [], inlineMeasure).map((line, index) => [
      {
        ...raisedSegment(index === 0 ? padKey(token) : " ".repeat(TOKEN_WIDTH), role),
        ...(bold ? { bold: true } : {})
      },
      raisedSegment(`  ${line.text}`, "prose · dim")
    ]);
  }
  const descriptionMeasure = Math.max(1, width - 2);
  return [
    [{ ...raisedSegment(token, role), ...(bold ? { bold: true } : {}) }],
    ...wrapText(description, [], descriptionMeasure)
      .map((line) => [raisedSegment(`  ${line.text}`, "prose · dim")])
  ];
}

function heading(section: KeysModalSection): string {
  return `● ${section.title}`;
}

/** Right-align in the key column by cells; `padStart` counts code units. */
function padKey(token: string): string {
  return " ".repeat(Math.max(0, TOKEN_WIDTH - visibleWidth(token))) + token;
}

/** Contiguous grouping that minimises the tallest column, so the reference is
 *  as short as its sections allow before any of it has to scroll. The smallest
 *  limit greedy packing can meet is the answer; one column always meets the
 *  total, so the search terminates there. */
function dealColumns(blocks: readonly FrameLine[][], columns: number): FrameLine[][] {
  const heights = blocks.map((block) => block.length);
  const total = heights.reduce((sum, value) => sum + value, 0) + blocks.length - 1;
  let limit = Math.max(...heights);
  while (limit < total && packWithin(heights, limit).length > columns) limit += 1;
  return packWithin(heights, limit).map((group) => group.flatMap((index, position) =>
    // A blank row separates sections sharing a column; the first needs none.
    position === 0 ? blocks[index]! : [[], ...blocks[index]!]));
}

/** Greedy contiguous grouping under a height limit, which every block fits:
 *  the caller never searches below the tallest one. */
function packWithin(heights: readonly number[], limit: number): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let used = 0;
  for (const [index, height] of heights.entries()) {
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
