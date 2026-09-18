import assert from "node:assert/strict";
import test from "node:test";

// No Electron and no real browser DOM: `renderer-icons.ts` only touches
// `document` inside its exported builder functions (never at module load),
// so a minimal SVG-element stand-in is enough to check the shapes it builds.
// See scratchpad/spec3/B-rail-icons.md.

class FakeSvgElement {
  readonly tagName: string;
  private readonly attrs = new Map<string, string>();
  readonly children: FakeSvgElement[] = [];

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  append(...nodes: readonly FakeSvgElement[]): void {
    this.children.push(...nodes);
  }
}

(globalThis as { document?: unknown }).document = {
  createElementNS: (_ns: string, tag: string) => new FakeSvgElement(tag)
};

const { RAIL_ICONS } = await import("../renderer-icons.js");
const { RAIL_DESTINATIONS } = await import("../renderer-shell-view.js");

const SHAPE_TAGS = new Set(["path", "circle", "rect"]);

test("every rail icon draws on the 24x24 viewBox with the shared stroke", () => {
  for (const [tab, build] of Object.entries(RAIL_ICONS)) {
    const svg = build() as unknown as FakeSvgElement;
    assert.equal(svg.tagName, "svg", `${tab} icon must be an <svg>`);
    assert.equal(svg.getAttribute("viewBox"), "0 0 24 24", `${tab} icon must use the 24x24 viewBox`);
    assert.equal(svg.getAttribute("stroke"), "currentColor", `${tab} icon must stroke with currentColor`);
    assert.equal(svg.getAttribute("fill"), "none", `${tab} icon must not fill by default`);
    assert.equal(svg.getAttribute("aria-hidden"), "true", `${tab} icon must be aria-hidden`);
  }
});

test("every rail icon carries at least one path, circle, or rect", () => {
  for (const [tab, build] of Object.entries(RAIL_ICONS)) {
    const svg = build() as unknown as FakeSvgElement;
    const shapeChild = svg.children.find((child) => SHAPE_TAGS.has(child.tagName));
    assert.ok(shapeChild !== undefined, `${tab} icon must contain a path, circle, or rect`);
  }
});

test("the rail's destination list and the icon map cover the same set", () => {
  const destinations = [...RAIL_DESTINATIONS].sort();
  const iconTabs = Object.keys(RAIL_ICONS).sort();
  assert.deepEqual(destinations, iconTabs, "every rail destination needs exactly one icon, and every icon needs a destination");
});
