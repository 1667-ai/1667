/** Map (⌘5, D-30…D-32): the stemma. Your line is the horizontal spine;
 * other lines leave on curves; forkless runs collapse to a bar. Geometry
 * lives in `renderer-map-layout.ts` (pure, tested without Electron) — this
 * file only draws it and keeps the accessible fallbacks (`.map-focus`,
 * `.map-fact-anchor`) the pre-stemma map already had.
 *
 * Reduced scope: no minimap, no fisheye lens, no regen clouds, no ⌥-click
 * compare (see `05-map-braid-aside.md` §0). */
import type { NodeStub, StoryPathNode, StoryPayload } from "../shared/types.js";
import { actionButton, el, panelHeading } from "./renderer-dom.js";
import { computeMapLayout, type MapLayout } from "./renderer-map-layout.js";
import { effectiveFocusedPartId, factLabel, type RendererActions, type RendererState } from "./renderer-model.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Readonly<Record<string, string | number>> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

/** Single-slot memoisation keyed on `story.nodes`/`story.path` identity — the
 * server hands back a fresh payload (and fresh arrays) on every mutation, so
 * reference equality is a fine, cheap stand-in for "story.revision" and lets
 * an unrelated re-render (a keystroke elsewhere, a popover opening) skip
 * recomputing the layout entirely. */
let cached: { readonly nodes: readonly NodeStub[]; readonly path: readonly StoryPathNode[]; readonly focusedId: string | null; readonly layout: MapLayout } | null = null;

function layoutFor(story: StoryPayload, focusedId: string | null): MapLayout {
  if (cached !== null && cached.nodes === story.nodes && cached.path === story.path && cached.focusedId === focusedId) return cached.layout;
  const layout = computeMapLayout(story, focusedId);
  cached = { nodes: story.nodes, path: story.path, focusedId, layout };
  return layout;
}

function edgePath(from: { x: number; y: number }, to: { x: number; y: number }, onPath: boolean): string {
  if (onPath) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const midY = (from.y + to.y) / 2;
  return `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`;
}

function renderStemma(state: RendererState, layout: MapLayout, actions: RendererActions): SVGSVGElement {
  const svg = svgEl("svg", { class: "stemma", viewBox: `0 0 ${layout.width} ${layout.height}`, width: layout.width, height: layout.height });
  const edges = svgEl("g", { class: "map-edges" });
  for (const edge of layout.edges) {
    const path = svgEl("path", {
      class: `map-edge ${edge.onPath ? "on-path" : "off-path"}${edge.cold ? " cold" : ""}`,
      d: edgePath(edge.from, edge.to, edge.onPath)
    });
    edges.append(path);
  }
  svg.append(edges);

  const ticks = svgEl("g", { class: "map-chapter-ticks" });
  for (const tick of layout.chapterTicks) {
    ticks.append(svgEl("line", { class: "map-chapter-tick", x1: tick.x, x2: tick.x, y1: layout.height / 2 - 26, y2: layout.height / 2 - 18 }));
  }
  svg.append(ticks);

  const runs = svgEl("g", { class: "map-collapsed-runs" });
  for (const run of layout.collapsedRuns) {
    const rect = svgEl("rect", {
      class: "map-collapsed-run",
      x: run.x - run.width / 2, y: run.y - 5, width: run.width, height: 10, rx: 5
    });
    rect.addEventListener("click", () => actions.switchNode(run.tipNodeId));
    const title = svgEl("title");
    title.textContent = `⋯ ${run.count} ¶ · ${run.words.toLocaleString()} words`;
    rect.append(title);
    runs.append(rect);
  }
  svg.append(runs);

  const nodes = svgEl("g", { class: "map-nodes" });
  for (const node of layout.nodes) {
    const classes = ["map-node", node.onPath ? "on-path" : "off-path"];
    if (node.deadEnd) classes.push("dead-end");
    if (node.cold) classes.push("cold");
    if (node.summary) classes.push("summary");
    const shape = node.summary
      ? svgEl("rect", { x: node.x - node.r, y: node.y - node.r, width: node.r * 2, height: node.r * 2, transform: `rotate(45 ${node.x} ${node.y})` })
      : svgEl("circle", { cx: node.x, cy: node.y, r: node.r });
    shape.setAttribute("class", classes.join(" "));
    shape.addEventListener("click", () => actions.switchNode(node.id));
    const title = svgEl("title");
    title.textContent = `${node.preview || "Untitled part"} · ${node.words.toLocaleString()} words`;
    shape.append(title);
    nodes.append(shape);
    if (node.ring) nodes.append(svgEl("circle", { class: "map-node-ring", cx: node.x, cy: node.y, r: node.r + 3 }));
    if (state.mapCursorId === node.id) nodes.append(svgEl("circle", { class: "map-cursor", cx: node.x, cy: node.y, r: node.r + 6 }));
    if (node.deadEnd) {
      const mark = svgEl("text", { class: "map-dead-end-mark", x: node.x, y: node.y + 3, "text-anchor": "middle" });
      mark.textContent = "✕";
      nodes.append(mark);
    }
  }
  svg.append(nodes);
  return svg;
}

function renderAccessibleList(layout: MapLayout, actions: RendererActions): HTMLElement {
  const list = el("ul", "map-list");
  for (const node of layout.nodes) {
    const item = el("li", "map-list-item");
    const label = node.onPath ? `¶ ${node.partNumber ?? "?"} · shown` : node.preview || "Untitled part";
    const focus = actionButton("map-focus", node.onPath ? "current" : "focus", () => actions.switchNode(node.id));
    focus.setAttribute("aria-label", node.onPath ? `${label}, current` : `Focus ${label}`);
    focus.dataset.preserve = `map:${node.id}`;
    item.append(el("span", "map-list-label", label), focus);
    list.append(item);
  }
  for (const run of layout.collapsedRuns) {
    const item = el("li", "map-list-item map-list-run");
    const focus = actionButton("map-focus", `⋯ ${run.count} ¶ · ${run.words.toLocaleString()} words`, () => actions.switchNode(run.tipNodeId));
    focus.dataset.preserve = `map-run:${run.id}`;
    item.append(focus);
    list.append(item);
  }
  return list;
}

function renderFactLens(story: StoryPayload, actions: RendererActions): HTMLElement {
  const anchors = story.facts.flatMap((fact) => fact.states.filter((state) => state.anchorPartId !== undefined).map((state) => ({ fact, state })));
  const lens = el("section", "map-fact-lens");
  lens.append(el("div", "panel-subheading", el("span", "eyebrow", "Fact lens"), el("strong", "", `${anchors.length} anchored state${anchors.length === 1 ? "" : "s"}`)));
  if (anchors.length === 0) lens.append(el("p", "empty-copy", "Anchored Fact states appear here."));
  for (const { fact, state } of anchors) {
    const anchor = state.anchorPartId;
    if (anchor === undefined) continue;
    const node = story.nodes.find((candidate) => candidate.id === anchor);
    const button = actionButton("map-fact-anchor", `${factLabel(fact)} · ${node?.preview ?? anchor.slice(0, 8)}`, () => actions.switchNode(anchor));
    button.dataset.preserve = `map-fact:${fact.id}:${anchor}`;
    lens.append(button);
  }
  return lens;
}

export function renderMap(story: StoryPayload, state: RendererState, actions: RendererActions): HTMLElement {
  const panel = el("div", "panel map-panel");
  panel.append(panelHeading("Map", "Your line is the spine. Click a take to focus that part on that line."));
  if (story.path.length === 0) {
    panel.append(el("p", "empty-copy", "The map is empty until the first line is written."));
    panel.append(renderFactLens(story, actions));
    return panel;
  }
  const focusedId = effectiveFocusedPartId(state, story);
  const layout = layoutFor(story, focusedId);
  const stage = el("div", "map-stage", renderStemma(state, layout, actions));
  panel.append(stage);
  if (layout.windowed) {
    panel.append(el("p", "map-window-note", `Showing ¶ ${layout.windowStart + 1}–${layout.windowEnd} of ${layout.totalParts}.`));
  }
  panel.append(renderAccessibleList(layout, actions));
  panel.append(renderFactLens(story, actions));
  return panel;
}
