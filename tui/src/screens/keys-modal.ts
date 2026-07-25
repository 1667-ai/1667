import { type HitRows } from "../hit.js";
import type { AppMode, KeyAction } from "../keys.js";
import type { MapView } from "../map-state.js";
import { panelWidthFor, placePanel, raisedSegment } from "./overlay.js";
import { visibleWidth, type DisplayRole, type FrameComposition, type FrameLine } from "./story/frame.js";

export interface KeysModalBinding {
  name: string;
  mode: AppMode;
  action: KeyAction;
  sequence?: string;
  shift?: boolean;
  ctrl?: boolean;
  mapView?: MapView;
}

export type KeysModalBand = "MOVE" | "WRITE" | "SHAPE" | "OPEN";
export type KeysModalCapBand = KeysModalBand | "UTILITY" | "INACTIVE";

interface LegendPlacement {
  order: number;
  dividerBefore?: boolean;
  showLabel?: boolean;
  accent?: boolean;
}

interface DiscoveryPlacement {
  order: number;
  label: string;
  token?: string;
}

export interface KeysModalCap {
  key: string;
  band: KeysModalCapBand;
  bindings: readonly KeysModalBinding[];
  label?: string;
  legend?: LegendPlacement;
  discovery?: DiscoveryPlacement;
  arrowCopy?: string;
  footerCopy?: string;
}

interface KeysModalBandDefinition {
  band: KeysModalCapBand;
  role: DisplayRole;
  inLegend?: boolean;
}

interface KeysModalDiagramDefinition {
  bands: readonly KeysModalBandDefinition[];
  capRows: readonly (readonly KeysModalCap[])[];
  arrowRows: readonly (readonly KeysModalCap[])[];
  utilityCaps: readonly KeysModalCap[];
  shortcuts: readonly KeysModalCap[];
}

export interface KeysModalLegendItem {
  token: string;
  label?: string;
  dividerBefore: boolean;
  accent: boolean;
  bindings: readonly KeysModalBinding[];
}

export interface KeysModalBandGroup {
  band: KeysModalBand;
  role: DisplayRole;
  items: readonly KeysModalLegendItem[];
}

export interface KeysModalArrowCopy {
  token: string;
  text: string;
}

export interface KeysModalDiscoveryItem {
  token: string;
  label: string;
  band: KeysModalCapBand;
  bindings: readonly KeysModalBinding[];
}

export interface KeysModalModel {
  capRows: readonly (readonly KeysModalCap[])[];
  arrowRows: readonly (readonly KeysModalCap[])[];
  utilityCaps: readonly KeysModalCap[];
  bindings: readonly KeysModalBinding[];
  bandGroups: readonly KeysModalBandGroup[];
  arrowCopy: readonly KeysModalArrowCopy[];
  discoveries: readonly KeysModalDiscoveryItem[];
  footer: string;
}

const binding = (
  name: string,
  mode: AppMode,
  action: KeyAction,
  extra: Partial<KeysModalBinding> = {}
): KeysModalBinding => ({ name, mode, action, ...extra });

const cap = (
  key: string,
  band: KeysModalCapBand,
  bindings: readonly KeysModalBinding[] = [],
  presentation: Omit<KeysModalCap, "key" | "band" | "bindings"> = {}
): KeysModalCap => ({ key, band, bindings, ...presentation });

/** Physical geography, semantics, display copy, and ordered legends. Inactive
 * caps stay present so h/j/k read as deliberately unbound. Everything the
 * renderer and resolver-contract tests need is derived from this definition. */
const KEYS_MODAL_DIAGRAM: KeysModalDiagramDefinition = {
  bands: [
    { band: "MOVE", role: "focus / accent", inLegend: true },
    { band: "WRITE", role: "human edit", inLegend: true },
    { band: "SHAPE", role: "bookmark · alt", inLegend: true },
    { band: "OPEN", role: "bookmark · canon", inLegend: true },
    { band: "UTILITY", role: "prose · dim" },
    { band: "INACTIVE", role: "dimmed page" }
  ],
  capRows: [
    [
      cap("q", "UTILITY", [binding("q", "NAV", "quit")], {
        discovery: { order: 0, label: "quit" }
      }),
      cap("w", "WRITE", [binding("w", "NAV", "write")], { legend: { order: 4 } }),
      cap("e", "WRITE", [binding("e", "NAV", "edit")], { legend: { order: 5 } }),
      cap("r", "WRITE", [binding("r", "NAV", "regenerate")], { legend: { order: 3 } }),
      cap("t", "INACTIVE"),
      cap("y", "WRITE", [
        binding("y", "NAV", "copy-part"),
        binding("Y", "NAV", "copy-line", { shift: true })
      ], { discovery: { order: 3, token: "y/Y", label: "copy" } }),
      cap("u", "MOVE", [binding("u", "NAV", "undo")], { legend: { order: 3 } }),
      cap("i", "WRITE", [binding("i", "NAV", "compose")], { legend: { order: 1 } }),
      cap("o", "OPEN", [binding("o", "NAV", "open-library")], { legend: { order: 2 } }),
      cap("p", "SHAPE", [binding("p", "NAV", "toggle-instructions")], { legend: { order: 2 } })
    ],
    [
      cap("a", "SHAPE", [
        binding("a", "MAP", "toggle-path-takes", { mapView: "path" }),
        binding("a", "MAP", "toggle-sketches", { mapView: "tree" }),
        binding("a", "MAP", "toggle-sketches", { mapView: "mass" })
      ], { discovery: { order: 4, label: "map detail" } }),
      cap("s", "SHAPE", [
        binding("s", "MAP", "map-cycle-sort", { mapView: "tree" }),
        binding("s", "MAP", "map-cycle-sort", { mapView: "mass" })
      ], { legend: { order: 4 } }),
      cap("d", "SHAPE", [
        binding("d", "NAV", "prune"),
        binding("d", "MAP", "prune", { mapView: "path" })
      ], { legend: { order: 0 } }),
      cap("f", "OPEN", [
        binding("f", "NAV", "open-facts")
      ], { legend: { order: 1 } }),
      cap("g", "MOVE", [
        binding("g", "NAV", "top"),
        binding("G", "NAV", "leaf", { shift: true })
      ], { legend: { order: 2 } }),
      cap("h", "INACTIVE"),
      cap("j", "INACTIVE"),
      cap("k", "INACTIVE"),
      cap("l", "MOVE", [
        binding("l", "MAP", "map-follow", { mapView: "tree" }),
        binding("l", "MAP", "map-follow", { mapView: "mass" })
      ], {
        label: "map follow/open",
        legend: { order: 4, dividerBefore: true, showLabel: true, accent: true }
      }),
      cap(";", "INACTIVE")
    ],
    [
      cap("z", "SHAPE", [binding("z", "NAV", "typewriter")], { legend: { order: 3 } }),
      cap("x", "SHAPE", [binding("x", "NAV", "open-actions")], {
        discovery: { order: 2, label: "menu" }
      }),
      cap("c", "OPEN", [
        binding("c", "NAV", "open-chapters"),
        binding("C", "NAV", "create-chapter", { shift: true })
      ], { discovery: { order: 1, token: "c/C", label: "chapters" } }),
      cap("v", "INACTIVE"),
      cap("b", "SHAPE", [
        binding("b", "NAV", "bookmark"),
        binding("b", "MAP", "bookmark", { mapView: "path" })
      ], { legend: { order: 1 } }),
      cap("n", "WRITE", [binding("n", "NAV", "new-item")], {
        label: "new story",
        legend: { order: 2, showLabel: true }
      }),
      cap("m", "OPEN", [
        binding("m", "NAV", "open-map"),
        binding("m", "MAP", "cycle-map-view")
      ], { legend: { order: 0 } })
    ]
  ],
  arrowRows: [
    [
      cap("↑", "MOVE", [
        binding("up", "NAV", "focus-previous"),
        binding("up", "MAP", "focus-previous", { mapView: "path" }),
        binding("up", "MAP", "focus-previous", { mapView: "tree" }),
        binding("up", "MAP", "focus-previous", { mapView: "mass" })
      ], { legend: { order: 0 }, arrowCopy: "move" })
    ],
    [
      cap("←", "MOVE", [
        binding("left", "NAV", "take-previous"),
        binding("left", "MAP", "take-previous", { mapView: "path" })
      ], { legend: { order: 1 }, arrowCopy: "takes" }),
      cap("↓", "MOVE", [
        binding("down", "NAV", "focus-next"),
        binding("down", "MAP", "focus-next", { mapView: "path" }),
        binding("down", "MAP", "focus-next", { mapView: "tree" }),
        binding("down", "MAP", "focus-next", { mapView: "mass" })
      ], { legend: { order: 0 }, arrowCopy: "move" }),
      cap("→", "MOVE", [
        binding("right", "NAV", "take-next"),
        binding("right", "MAP", "take-next", { mapView: "path" })
      ], { legend: { order: 1 }, arrowCopy: "takes" })
    ]
  ],
  utilityCaps: [
    cap("enter", "WRITE", [binding("return", "NAV", "compose")], {
      label: "direct",
      legend: { order: 0 }
    }),
    cap(":", "OPEN", [binding(":", "NAV", "open-commands")], {
      label: "cmd"
    }),
    cap(",", "OPEN", [binding(",", "NAV", "open-settings")], {
      label: "settings",
      legend: { order: 4, dividerBefore: true }
    }),
    cap("esc", "UTILITY", [binding("escape", "KEYS", "cancel")], { footerCopy: "closes" })
  ],
  shortcuts: [
    cap("␠", "WRITE", [binding("space", "NAV", "continue")], {
      label: "continue",
      legend: { order: 7, dividerBefore: true, showLabel: true }
    }),
    cap("R", "WRITE", [binding("R", "NAV", "retake-with-prompt", { shift: true })], {
      label: "reprompt",
      discovery: { order: 5, label: "reprompt" }
    }),
    cap("?", "OPEN", [binding("?", "NAV", "open-keys")], { legend: { order: 5 } }),
    cap("⌃p/:", "OPEN", [binding("p", "NAV", "open-commands", { ctrl: true })], {
      label: "commands",
      legend: { order: 3, showLabel: true, accent: true }
    }),
    cap("⌃g", "OPEN", [
      binding("g", "NAV", "toggle-context-meter", { ctrl: true }),
      binding("g", "COMPOSE", "toggle-context-meter", { ctrl: true })
    ], {
      label: "wide context details",
      legend: { order: 6, dividerBefore: true, showLabel: true }
    }),
    cap("⌃↑↓", "WRITE", [
      binding("up", "COMPOSE", "history-previous", { ctrl: true }),
      binding("down", "COMPOSE", "history-next", { ctrl: true })
    ], {
      label: "history",
      legend: { order: 6, dividerBefore: true, showLabel: true }
    }),
    cap("F", "OPEN", [binding("F", "NAV", "toggle-rail", { shift: true })], {
      label: "rail",
      legend: { order: 7, dividerBefore: true, showLabel: true }
    })
  ]
};

export const KEYS_MODAL_MODEL: KeysModalModel = deriveKeysModalModel(KEYS_MODAL_DIAGRAM);

const BAND_ROLES = new Map(
  KEYS_MODAL_DIAGRAM.bands.map((definition) => [definition.band, definition.role] as const)
);

export function renderKeysOverlay(base: FrameLine[], hits: HitRows, width: number, height: number): FrameComposition {
  const keyboard = renderKeyboard();
  const arrows = renderArrowCluster();
  const content: FrameLine[] = keyboard.map((line, index) => placeArrowCluster(line, arrows[index] ?? []));
  content.push([]);
  content.push(renderUtilityCaps());
  content.push(renderLegendLine(KEYS_MODAL_MODEL.bandGroups.slice(0, 1)));
  content.push(renderLegendLine(KEYS_MODAL_MODEL.bandGroups.slice(1, 2)));
  content.push(renderLegendLine(KEYS_MODAL_MODEL.bandGroups.slice(2, 3)));
  content.push(renderLegendLine(KEYS_MODAL_MODEL.bandGroups.slice(3, 4)));
  content.push(...renderDiscoveryLines(
    KEYS_MODAL_MODEL.discoveries,
    panelWidthFor(width, 76) - visibleWidth("┃ ")
  ));

  // Inert, not transparent: without hits the story's own rows stay live under
  // the modal, so a click outside would not even dismiss it.
  return placePanel(
    base,
    "keys · laid where your fingers are",
    content,
    "drag/⇧arrows select · ctrl+c copy · ctrl+v paste · esc closes",
    width,
    height,
    76,
    { rows: hits, targets: content.map(() => null) }
  );
}

function deriveKeysModalModel(diagram: KeysModalDiagramDefinition): KeysModalModel {
  const arrowCaps = diagram.arrowRows.flat();
  const allCaps = [
    ...diagram.capRows.flat(),
    ...arrowCaps,
    ...diagram.utilityCaps,
    ...diagram.shortcuts
  ];
  const arrowCopy = groupedCopy(arrowCaps);
  const discoveries = allCaps
    .filter((item): item is KeysModalCap & { discovery: DiscoveryPlacement } => item.discovery !== undefined)
    .sort((left, right) => left.discovery.order - right.discovery.order)
    .map((item) => ({
      token: item.discovery.token ?? item.key,
      label: item.discovery.label,
      band: item.band,
      bindings: item.bindings
    }));
  const bandGroups = diagram.bands
    .filter((definition): definition is KeysModalBandDefinition & { band: KeysModalBand } =>
      definition.inLegend === true)
    .map((definition) => ({
      band: definition.band,
      role: definition.role,
      items: legendItems(allCaps, definition.band)
    }));
  const footer = [
    ...arrowCopy.map((item) => `${item.token} ${item.text}`),
    ...diagram.utilityCaps
      .filter((item) => item.footerCopy !== undefined)
      .map((item) => `${item.key} ${item.footerCopy}`)
  ].join(" · ");
  return {
    capRows: diagram.capRows,
    arrowRows: diagram.arrowRows,
    utilityCaps: diagram.utilityCaps,
    bindings: allCaps.flatMap((item) => item.bindings),
    bandGroups,
    arrowCopy,
    discoveries,
    footer
  };
}

function legendItems(caps: readonly KeysModalCap[], band: KeysModalBand): KeysModalLegendItem[] {
  const grouped = new Map<number, KeysModalLegendItem>();
  for (const item of caps) {
    if (item.band !== band || item.legend === undefined) continue;
    const existing = grouped.get(item.legend.order);
    if (existing !== undefined) {
      existing.token += item.key;
      existing.bindings = [...existing.bindings, ...item.bindings];
      continue;
    }
    grouped.set(item.legend.order, {
      token: item.key,
      ...(item.legend.showLabel === true && item.label !== undefined ? { label: item.label } : {}),
      dividerBefore: item.legend.dividerBefore === true,
      accent: item.legend.accent === true,
      bindings: [...item.bindings]
    });
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item);
}

function groupedCopy(caps: readonly KeysModalCap[]): KeysModalArrowCopy[] {
  const grouped = new Map<string, KeysModalArrowCopy>();
  for (const item of caps) {
    if (item.arrowCopy === undefined) continue;
    const existing = grouped.get(item.arrowCopy);
    if (existing === undefined) grouped.set(item.arrowCopy, { token: item.key, text: item.arrowCopy });
    else existing.token += item.key;
  }
  return [...grouped.values()];
}

function renderKeyboard(): FrameLine[] {
  return [
    chromeLine("  ┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐"),
    renderCapRow(KEYS_MODAL_MODEL.capRows[0]!),
    chromeLine("  ├───┼───┼───┼───┼───┼───┼───┼───┼───┼───┤"),
    renderCapRow(KEYS_MODAL_MODEL.capRows[1]!),
    chromeLine("  ├───┼───┼───┼───┼───┼───┴───┴───┴───┴───┘"),
    renderCapRow(KEYS_MODAL_MODEL.capRows[2]!),
    chromeLine("  └───┴───┴───┴───┴───┴───┘")
  ];
}

function renderCapRow(caps: readonly KeysModalCap[]): FrameLine {
  const line: FrameLine = [raisedSegment("  ", "chrome")];
  for (const item of caps) {
    line.push(
      raisedSegment("│ ", "chrome"),
      raisedSegment(item.key, roleFor(item.band)),
      raisedSegment(" ", "chrome")
    );
  }
  line.push(raisedSegment("│", "chrome"));
  return line;
}

function renderArrowCluster(): FrameLine[] {
  const [up, directions] = KEYS_MODAL_MODEL.arrowRows;
  return [
    chromeLine("    ┌───┐"),
    [raisedSegment("    ", "chrome"), ...renderArrowRow(up!)],
    chromeLine("┌───┼───┼───┐"),
    renderArrowRow(directions!),
    chromeLine("└───┴───┴───┘"),
    ...KEYS_MODAL_MODEL.arrowCopy.map((item) => [
      raisedSegment(item.token, roleFor("MOVE")),
      raisedSegment(` ${item.text}`, "chrome")
    ])
  ];
}

function renderArrowRow(caps: readonly KeysModalCap[]): FrameLine {
  const line: FrameLine = [];
  for (const item of caps) {
    line.push(
      raisedSegment("│ ", "chrome"),
      raisedSegment(item.key, roleFor(item.band)),
      raisedSegment(" ", "chrome")
    );
  }
  line.push(raisedSegment("│", "chrome"));
  return line;
}

function placeArrowCluster(keyboard: FrameLine, arrows: FrameLine): FrameLine {
  const keyboardWidth = visibleWidth(keyboard.map((item) => item.text).join(""));
  return [
    ...keyboard,
    raisedSegment(" ".repeat(Math.max(3, 47 - keyboardWidth)), "chrome"),
    ...arrows
  ];
}

function renderUtilityCaps(): FrameLine {
  const line: FrameLine = [raisedSegment("  ", "chrome")];
  KEYS_MODAL_MODEL.utilityCaps.forEach((item, index) => {
    if (index > 0) line.push(raisedSegment("   ", "chrome"));
    line.push(
      raisedSegment("[ ", "chrome"),
      raisedSegment(item.key, roleFor(item.band)),
      raisedSegment(`${item.label === undefined ? "" : ` ${item.label}`} ]`, "chrome")
    );
  });
  return line;
}

function renderLegendLine(groups: readonly KeysModalBandGroup[]): FrameLine {
  const line: FrameLine = [];
  for (const [groupIndex, group] of groups.entries()) {
    if (groupIndex > 0) line.push(raisedSegment("   ", "prose · dim"));
    line.push(
      raisedSegment("  ●", group.role),
      raisedSegment(` ${group.band.padEnd(6)}`, "prose · dim")
    );
    for (const [itemIndex, item] of group.items.entries()) {
      if (itemIndex > 0) {
        line.push(raisedSegment(item.dividerBefore ? " · " : " ", "prose · dim"));
      }
      line.push(raisedSegment(item.token, item.accent ? group.role : "prose · dim"));
      if (item.label !== undefined) line.push(raisedSegment(` ${item.label}`, "prose · dim"));
    }
  }
  return line;
}

function renderDiscoveryLines(
  items: readonly KeysModalDiscoveryItem[],
  width: number
): FrameLine[] {
  const firstPrefix = "  ◦ MORE   ";
  const continuedPrefix = " ".repeat(visibleWidth(firstPrefix));
  const lines: FrameLine[] = [];
  let line: FrameLine = [raisedSegment(firstPrefix, "prose · dim")];
  let used = visibleWidth(firstPrefix);
  let itemCount = 0;
  for (const item of items) {
    const separator = itemCount === 0 ? "" : " · ";
    const itemWidth = visibleWidth(separator) + visibleWidth(item.token) + 1 + visibleWidth(item.label);
    if (itemCount > 0 && used + itemWidth > width) {
      lines.push(line);
      line = [raisedSegment(continuedPrefix, "prose · dim")];
      used = visibleWidth(continuedPrefix);
      itemCount = 0;
    }
    const actualSeparator = itemCount === 0 ? "" : " · ";
    if (actualSeparator.length > 0) line.push(raisedSegment(actualSeparator, "prose · dim"));
    line.push(
      raisedSegment(item.token, roleFor(item.band)),
      raisedSegment(` ${item.label}`, "prose · dim")
    );
    used += visibleWidth(actualSeparator) + visibleWidth(item.token) + 1 + visibleWidth(item.label);
    itemCount += 1;
  }
  if (itemCount > 0 || lines.length === 0) lines.push(line);
  return lines;
}

function roleFor(band: KeysModalCapBand): DisplayRole {
  return BAND_ROLES.get(band)!;
}

function chromeLine(text: string): FrameLine {
  return [raisedSegment(text, "chrome")];
}
