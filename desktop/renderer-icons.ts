/** Inline icon set for the destination rail (Phase B, answers R-03). Each
 * function draws one destination on a 24x24 viewBox, stroke-only
 * (`fill="none"`, `stroke="currentColor"`, `stroke-width="1.5"`, round caps
 * and joins), sized to read at 20px inside the rail's 40x40 buttons.
 *
 * `document.createElementNS` is called only inside these functions, never at
 * module load, so `desktop-rail-icons.test.ts` can stand up a minimal SVG
 * document and check the shapes with no Electron and no real browser DOM. */

import type { RendererTab } from "./renderer-model.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string | number>> = {}
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function icon(...children: readonly SVGElement[]): SVGSVGElement {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true"
  });
  svg.append(...children);
  return svg;
}

/** Library: a stack of horizontal cards. */
export function libraryIcon(): SVGSVGElement {
  return icon(
    svgEl("rect", { x: 3, y: 4, width: 18, height: 4, rx: 1.2 }),
    svgEl("rect", { x: 3, y: 10.5, width: 18, height: 4, rx: 1.2 }),
    svgEl("rect", { x: 3, y: 17, width: 18, height: 4, rx: 1.2 })
  );
}

/** Write: the brand mark's pilcrow, drawn as a path (never a text glyph) —
 * a bowl looping off a long stem, with the second short stem the character
 * needs to read as "¶" rather than a plain "P". */
export function writeIcon(): SVGSVGElement {
  return icon(
    svgEl("path", { d: "M14 4h-3.5a4 4 0 1 0 0 8H14" }),
    svgEl("path", { d: "M14 4v16" }),
    svgEl("path", { d: "M11.2 4v8" })
  );
}

/** Facts: a card with two lines of key/value text. */
export function factsIcon(): SVGSVGElement {
  return icon(
    svgEl("rect", { x: 4, y: 4, width: 16, height: 16, rx: 2 }),
    svgEl("path", { d: "M7.5 10h9" }),
    svgEl("path", { d: "M7.5 14h6" })
  );
}

/** Chapters: a book gutter, a vertical rule with two leaves. */
export function chaptersIcon(): SVGSVGElement {
  return icon(
    svgEl("path", { d: "M12 4v16" }),
    svgEl("path", { d: "M12 5.5H6a1 1 0 0 0-1 1V17.5a1 1 0 0 0 1 1h6" }),
    svgEl("path", { d: "M12 5.5h6a1 1 0 0 1 1 1V17.5a1 1 0 0 1-1 1h-6" })
  );
}

/** Map: a spine with one branch leaving it, matching the app's stemma (dot
 * nodes joined by lines), not a generic version-control fork glyph. */
export function mapIcon(): SVGSVGElement {
  return icon(
    svgEl("path", { d: "M8 4v16" }),
    svgEl("path", { d: "M8 10l8 5v5" }),
    svgEl("circle", { cx: 8, cy: 10, r: 1.4, fill: "currentColor", stroke: "none" }),
    svgEl("circle", { cx: 16, cy: 15, r: 1.4, fill: "currentColor", stroke: "none" })
  );
}

/** Inspect: a circle with a centre dot. */
export function inspectIcon(): SVGSVGElement {
  return icon(
    svgEl("circle", { cx: 12, cy: 12, r: 7.5 }),
    svgEl("circle", { cx: 12, cy: 12, r: 1.3, fill: "currentColor", stroke: "none" })
  );
}

/** Settings: a slider row, two horizontal rails with one handle each. */
export function settingsIcon(): SVGSVGElement {
  return icon(
    svgEl("path", { d: "M4 8h11" }),
    svgEl("circle", { cx: 17, cy: 8, r: 2, fill: "currentColor", stroke: "none" }),
    svgEl("path", { d: "M9 16h11" }),
    svgEl("circle", { cx: 7, cy: 16, r: 2, fill: "currentColor", stroke: "none" })
  );
}

/** One icon builder per rail destination, keyed by `RendererTab`. The rail
 * view renders `RAIL_ICONS[tab]()` fresh on every render; `renderRailButton`
 * in `renderer-shell-view.ts` is the only caller. */
export const RAIL_ICONS: Readonly<Record<RendererTab, () => SVGSVGElement>> = {
  library: libraryIcon,
  write: writeIcon,
  facts: factsIcon,
  chapters: chaptersIcon,
  map: mapIcon,
  inspect: inspectIcon,
  settings: settingsIcon
};
