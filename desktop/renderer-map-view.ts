/** Map (⌘5, D-30…D-32, D-34, D-35): the stemma plus the minimap plus the
 * fisheye lens. Your line is the horizontal spine; other lines leave on
 * curves; forkless runs collapse to a bar unless the lens opens them.
 * Geometry lives in `renderer-map-layout.ts` (stemma windowing, and now the
 * lens) and `renderer-minimap-layout.ts` (the minimap strip), both pure and
 * tested without Electron — this file only draws them, keeps the stage's
 * scroll position across a re-render that draws the same window, and keeps
 * the accessible fallbacks (`.map-focus`, `.map-fact-anchor`) the pre-stemma
 * map already had.
 *
 * The lens (D-34) follows the pointer while it sits over `.map-stage`, or
 * (when the pointer is elsewhere) the map cursor's take — see `hoverLens`
 * and `lensIndexForCursor` below. A pointer-driven move never calls
 * `setState`: it recomputes the layout and swaps only the stage's SVG (and
 * resyncs the minimap rectangle), because a full re-render on every
 * `pointermove` would be far too much work.
 *
 * Reduced scope: no regen clouds (see
 * `05-map-braid-aside.md` §0). */
import type { NodeStub, StoryPathNode, StoryPayload } from "../shared/types.js";
import { actionButton, el, panelHeading } from "./renderer-dom.js";
import { computeMapLayout, type MapLayout } from "./renderer-map-layout.js";
import { computeMinimapGeometry, minimapFractionRange, minimapPartIndexAtFraction, type MinimapGeometry } from "./renderer-minimap-layout.js";
import { effectiveFocusedPartId, factLabel, type RendererActions, type RendererState } from "./renderer-model.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_VIEWPORT_FRACTION = 0.02;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Readonly<Record<string, string | number>> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Single-slot memoisation keyed on `story.nodes`/`story.path` identity — the
 * server hands back a fresh payload (and fresh arrays) on every mutation, so
 * reference equality is a fine, cheap stand-in for "story.revision" and lets
 * an unrelated re-render (a keystroke elsewhere, a popover opening) skip
 * recomputing the layout entirely. Keyed on `lensIndex` too (D-34), so a
 * pointer hover recomputing the same index repeatedly (it moves within the
 * same lens far more often than it crosses out of it) is also free. */
let cached: { readonly nodes: readonly NodeStub[]; readonly path: readonly StoryPathNode[]; readonly focusedId: string | null; readonly centerPartId: string | null; readonly lensIndex: number | null; readonly layout: MapLayout } | null = null;

function layoutFor(story: StoryPayload, focusedId: string | null, centerPartId: string | null, lensIndex: number | null): MapLayout {
  if (cached !== null && cached.nodes === story.nodes && cached.path === story.path && cached.focusedId === focusedId && cached.centerPartId === centerPartId && cached.lensIndex === lensIndex) return cached.layout;
  const layout = computeMapLayout(story, focusedId, { centerPartId, lensIndex });
  cached = { nodes: story.nodes, path: story.path, focusedId, centerPartId, lensIndex, layout };
  return layout;
}

/** D-34: which spine index the pointer has pinned the lens to, kept at
 * module scope (like `scrollMemo` below) so a full re-render triggered while
 * the pointer sits over the stage — some unrelated state change — does not
 * drop the lens; only a real `pointerleave`, or entering Map fresh, clears
 * it. `null` means the pointer is not currently driving the lens. */
let hoverLens: { readonly storyId: string; readonly index: number } | null = null;

/** The nearest on-path spine node to `pointerX` (stage-local, SVG user
 * units), as a path index — `null` only when the layout draws no spine
 * (an empty story, which never reaches here since Map has its own empty
 * state). */
function nearestSpineIndex(layout: MapLayout, pointerX: number): number | null {
  let nearest: MapLayout["nodes"][number] | null = null;
  for (const node of layout.nodes) {
    if (!node.onPath) continue;
    if (nearest === null || Math.abs(node.x - pointerX) < Math.abs(nearest.x - pointerX)) nearest = node;
  }
  return nearest === null ? null : (nearest.partNumber ?? 1) - 1;
}

/** D-34 keyboard path: when `cursorId` names a take off the current line,
 * the lens centres where that take's line leaves it — walk parents until
 * one is on `story.path` (an alternate root take, `parentId: null`, diverges
 * right at spine index 0, mirroring `computeMapLayout`'s own root-sibling
 * handling). `null` when there is no cursor, or it names nothing live. */
function lensIndexForCursor(story: StoryPayload, cursorId: string | null): number | null {
  if (cursorId === null) return null;
  const pathIds = new Set(story.path.map((node) => node.id));
  const nodesById = new Map(story.nodes.map((node) => [node.id, node] as const));
  let node = nodesById.get(cursorId);
  if (node === undefined) return null;
  if (pathIds.has(node.id)) return story.path.findIndex((candidate) => candidate.id === node!.id);
  for (;;) {
    if (node.parentId === null) return 0;
    if (pathIds.has(node.parentId)) return story.path.findIndex((candidate) => candidate.id === node!.parentId);
    const parent = nodesById.get(node.parentId);
    if (parent === undefined) return null;
    node = parent;
  }
}

let minimapCache: { readonly nodes: readonly NodeStub[]; readonly path: readonly StoryPathNode[]; readonly geometry: MinimapGeometry } | null = null;

function minimapGeometryFor(story: StoryPayload): MinimapGeometry {
  if (minimapCache !== null && minimapCache.nodes === story.nodes && minimapCache.path === story.path) return minimapCache.geometry;
  const geometry = computeMinimapGeometry(story);
  minimapCache = { nodes: story.nodes, path: story.path, geometry };
  return geometry;
}

/** Remembers the stage's horizontal scroll across a re-render that draws the
 * same window (D-35 §1). Keyed on the drawn window, not on scroll position
 * itself: a windowing change (a new centre part moves
 * `[windowStart, windowEnd)`) invalidates it so the stage recentres instead
 * of restoring a stale position, and so does entering Map fresh (checked
 * separately in `renderMap`, since leaving Map removes `.map-stage`
 * entirely — nothing here would otherwise notice the gap). */
let scrollMemo: { readonly key: string; readonly scrollLeft: number } | null = null;

function stageScrollKey(story: StoryPayload, layout: MapLayout): string {
  return `${story.id}:${layout.windowStart}:${layout.windowEnd}`;
}

function edgePath(from: { x: number; y: number }, to: { x: number; y: number }, straight: boolean): string {
  if (straight) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const midY = (from.y + to.y) / 2;
  return `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`;
}

function renderStemma(state: RendererState, layout: MapLayout, actions: RendererActions): SVGSVGElement {
  const svg = svgEl("svg", { class: "stemma", viewBox: `0 0 ${layout.width} ${layout.height}`, width: layout.width, height: layout.height });
  if (layout.lens !== null) {
    svg.append(svgEl("rect", { class: "map-lens", x: layout.lens.x, y: 0, width: layout.lens.width, height: layout.height }));
  }
  const edges = svgEl("g", { class: "map-edges" });
  for (const edge of layout.edges) {
    const path = svgEl("path", {
      class: `map-edge ${edge.onPath ? "on-path" : "off-path"}${edge.cold ? " cold" : ""}`,
      d: edgePath(edge.from, edge.to, edge.straight)
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
    shape.addEventListener("click", (event) => {
      if ((event as MouseEvent).altKey) actions.compareTake(node.id);
      else actions.switchNode(node.id);
    });
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

/** D-35: the minimap strip below the stage, only for a story long enough to
 * need an overview. `stage` is the sibling `.map-stage` already in the tree
 * (not yet attached) — this wires the stage's own `scroll` event (both a
 * writer's native scroll and this control's own local scrolling) to keep the
 * viewport rectangle in sync, and drives `.map-stage.scrollLeft` back when
 * the writer drags, clicks, or arrows the rectangle.
 *
 * Returns a `refresh` alongside the element: a D-34 lens hover swaps the
 * stage's SVG for a new (differently windowed-by-fisheye) layout without a
 * full re-render, and `refresh` is how the caller keeps this control's own
 * node positions — and so the rectangle it draws from them — in sync with
 * that swap. */
function renderMinimap(story: StoryPayload, layout: MapLayout, stage: HTMLElement, actions: RendererActions): { readonly element: HTMLElement; readonly refresh: (layout: MapLayout) => void } {
  const geometry = minimapGeometryFor(story);
  let currentLayout = layout;
  const minimap = el("div", "map-minimap");
  const strip = svgEl("svg", { class: "map-minimap-strip", viewBox: "0 0 1000 20", preserveAspectRatio: "none" });
  strip.setAttribute("aria-hidden", "true");
  strip.append(svgEl("rect", { class: "map-minimap-line", x: 0, y: 8, width: 1000, height: 4 }));
  if (geometry.forkFractions.length > 0) {
    const d = geometry.forkFractions.map((fraction) => `M ${(fraction * 1000).toFixed(2)} 3 L ${(fraction * 1000).toFixed(2)} 17`).join(" ");
    strip.append(svgEl("path", { class: "map-minimap-forks", d }));
  }
  for (const tick of geometry.chapterTicks) {
    const x = (tick.fraction * 1000).toFixed(2);
    const line = svgEl("line", { class: "map-minimap-tick", x1: x, x2: x, y1: 0, y2: 20 });
    if (tick.title.trim().length > 0) {
      const title = svgEl("title");
      title.textContent = tick.title;
      line.append(title);
    }
    strip.append(line);
  }
  minimap.append(strip);

  const viewport = el("button", "map-minimap-viewport");
  viewport.type = "button";
  viewport.setAttribute("aria-label", "Map view. Drag it, or press Left and Right to move it.");
  minimap.append(viewport);

  let range = { start: 0, end: Math.max(0, story.path.length - 1) };
  let widthFraction = 1;

  const placeRectangle = (leftFraction: number): void => {
    const left = clamp(leftFraction, 0, 1 - widthFraction);
    viewport.style.left = `${(left * 100).toFixed(3)}%`;
    viewport.style.width = `${(widthFraction * 100).toFixed(3)}%`;
  };

  const applyRange = (start: number, end: number): void => {
    range = { start, end };
    const fractions = minimapFractionRange(geometry, start, end);
    widthFraction = Math.max(fractions.end - fractions.start, MIN_VIEWPORT_FRACTION);
    placeRectangle(fractions.start);
    viewport.setAttribute("aria-label", `Map view shows ¶ ${start + 1}–${end + 1} of ${story.path.length}. Drag it, or press Left and Right to move it.`);
  };

  const syncFromStage = (): void => {
    const visible = currentLayout.nodes.filter((node) =>
      node.onPath && node.partNumber !== undefined
      && node.x >= stage.scrollLeft - 1 && node.x <= stage.scrollLeft + stage.clientWidth + 1);
    if (visible.length === 0) return;
    const indices = visible.map((node) => node.partNumber! - 1);
    applyRange(Math.min(...indices), Math.max(...indices));
  };

  const isDrawn = (index: number): boolean => index >= currentLayout.windowStart && index < currentLayout.windowEnd;

  const scrollStageToIndex = (index: number): void => {
    const node = currentLayout.nodes.find((candidate) => candidate.onPath && candidate.partNumber === index + 1);
    if (node === undefined) return;
    const max = Math.max(0, stage.scrollWidth - stage.clientWidth);
    stage.scrollLeft = clamp(node.x - stage.clientWidth / 2, 0, max);
    syncFromStage();
  };

  // Outside the drawn window there is nothing to scroll to yet — commit a
  // new centre part instead (D-35 §3); a render follows and, once mounted,
  // recentres the stage on it (the same "key changed" path `renderMap`
  // already takes for any windowing change).
  const jumpTo = (index: number): void => {
    const clamped = clamp(index, 0, story.path.length - 1);
    if (isDrawn(clamped)) {
      scrollStageToIndex(clamped);
      return;
    }
    const id = story.path[clamped]?.id;
    if (id !== undefined) actions.setMapCenter(id);
  };

  stage.addEventListener("scroll", syncFromStage);

  const fractionAt = (clientX: number): number => {
    const rect = strip.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  };

  // A click lands on the strip only outside the rectangle — the rectangle
  // itself sits on top and handles its own pointer events below.
  strip.addEventListener("click", (event) => {
    const fraction = fractionAt(event.clientX);
    placeRectangle(fraction - widthFraction / 2);
    jumpTo(minimapPartIndexAtFraction(geometry, fraction));
  });

  let dragging = false;
  viewport.addEventListener("pointerdown", (event) => {
    dragging = true;
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const fraction = fractionAt(event.clientX);
    placeRectangle(fraction - widthFraction / 2);
    const index = minimapPartIndexAtFraction(geometry, fraction);
    if (isDrawn(index)) scrollStageToIndex(index);
  });
  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    jumpTo(minimapPartIndexAtFraction(geometry, fractionAt(event.clientX)));
  };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("lostpointercapture", () => { dragging = false; });
  viewport.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Stop the MAP keymap's own left/right (previous/next sibling take) from
    // also running behind the focused rectangle (the keys controller already
    // ignores a keydown whose default was prevented).
    event.preventDefault();
    const span = range.end - range.start;
    const step = Math.max(1, Math.round((span + 1) / 2));
    const center = Math.round((range.start + range.end) / 2);
    jumpTo(center + (event.key === "ArrowRight" ? step : -step));
  });

  applyRange(range.start, range.end);
  return {
    element: minimap,
    refresh: (newLayout) => {
      currentLayout = newLayout;
      syncFromStage();
    }
  };
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
  // The old tree (whatever tab was showing before this render) is still live
  // at this point — `renderApp` only swaps it in once the whole new tree is
  // built. No `.map-stage` there means the writer just switched into Map, so
  // the window must centre on the focused part even if it happens to match
  // whatever the stage last scrolled to before leaving — and, per D-34, that
  // a stale hover lens (the pointer left without ever crossing `.map-stage`
  // again, for instance a tab switch) does not reappear somewhere new.
  const enteringMap = document.querySelector(".map-stage") === null;
  if (enteringMap) hoverLens = null;
  const focusedId = effectiveFocusedPartId(state, story);
  const centerId = state.mapCenterPartId ?? focusedId;

  // D-34: the pointer drives the lens whenever it is over the stage; only
  // when it is not does the map cursor (keyboard navigation) drive it.
  const activeHoverIndex = hoverLens !== null && hoverLens.storyId === story.id ? hoverLens.index : null;
  const lensIndex = activeHoverIndex !== null ? activeHoverIndex : lensIndexForCursor(story, state.mapCursorId);

  const layout = layoutFor(story, focusedId, state.mapCenterPartId, lensIndex);
  // Tracks whichever layout is currently drawn in `stage` — the pointer
  // handlers below replace this (and only this) when a hover swaps the SVG
  // locally, without going through `renderMap` again.
  let layoutRef = layout;
  let minimapControl: { readonly element: HTMLElement; readonly refresh: (layout: MapLayout) => void } | null = null;

  const stage = el("div", "map-stage", renderStemma(state, layout, actions));
  stage.addEventListener("scroll", () => {
    scrollMemo = { key: stageScrollKey(story, layout), scrollLeft: stage.scrollLeft };
  });
  // A local lens move never calls `setState` (a `pointermove` fires far too
  // often for a full re-render) — it recomputes the layout, swaps only the
  // stage's `<svg>`, and resyncs the minimap rectangle by hand instead.
  stage.addEventListener("pointermove", (event) => {
    const svg = stage.querySelector<SVGSVGElement>("svg.stemma");
    if (svg === null) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const pointerX = event.clientX - rect.left;
    const hovering = hoverLens !== null && hoverLens.storyId === story.id;
    // Hysteresis: opening a lens moves the very nodes the pointer is next
    // to, so only move the lens once the pointer leaves its wash — checking
    // on every pixel of movement inside it would feed back into itself.
    if (hovering && layoutRef.lens !== null && pointerX >= layoutRef.lens.x && pointerX <= layoutRef.lens.x + layoutRef.lens.width) return;
    const newIndex = nearestSpineIndex(layoutRef, pointerX);
    if (newIndex === null || (hovering && hoverLens!.index === newIndex)) return;
    const newLayout = layoutFor(story, focusedId, state.mapCenterPartId, newIndex);
    svg.replaceWith(renderStemma(state, newLayout, actions));
    layoutRef = newLayout;
    hoverLens = { storyId: story.id, index: newIndex };
    minimapControl?.refresh(newLayout);
  });
  stage.addEventListener("pointerleave", () => {
    if (hoverLens === null || hoverLens.storyId !== story.id) return;
    hoverLens = null;
    // Give the lens back to the map cursor, if it holds one.
    const newLayout = layoutFor(story, focusedId, state.mapCenterPartId, lensIndexForCursor(story, state.mapCursorId));
    const svg = stage.querySelector<SVGSVGElement>("svg.stemma");
    if (svg !== null) svg.replaceWith(renderStemma(state, newLayout, actions));
    layoutRef = newLayout;
    minimapControl?.refresh(newLayout);
  });
  panel.append(stage);
  if (layout.windowed) {
    panel.append(el("p", "map-window-note", `Showing ¶ ${layout.windowStart + 1}–${layout.windowEnd} of ${layout.totalParts}.`));
  }
  if (story.path.length >= 2) {
    minimapControl = renderMinimap(story, layout, stage, actions);
    panel.append(minimapControl.element);
  }
  panel.append(renderAccessibleList(layout, actions));
  panel.append(renderFactLens(story, actions));

  const key = stageScrollKey(story, layout);
  const restoreScrollLeft = !enteringMap && scrollMemo !== null && scrollMemo.key === key ? scrollMemo.scrollLeft : null;
  queueMicrotask(() => {
    if (!stage.isConnected) return;
    if (restoreScrollLeft !== null) {
      stage.scrollLeft = restoreScrollLeft;
    } else {
      const node = layout.nodes.find((candidate) => candidate.id === centerId);
      if (node !== undefined) {
        const max = Math.max(0, stage.scrollWidth - stage.clientWidth);
        stage.scrollLeft = clamp(node.x - stage.clientWidth / 2, 0, max);
      }
    }
    // Setting `scrollLeft` does not fire `scroll` synchronously — dispatch it
    // so the minimap's own listener (and the memo above) sync immediately
    // rather than waiting on the browser's own, less predictable timing.
    stage.dispatchEvent(new Event("scroll"));
  });
  return panel;
}
