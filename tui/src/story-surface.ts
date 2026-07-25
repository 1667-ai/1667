import { TextRenderable, type CliRenderer, type ColorInput, type MouseEvent } from "@opentui/core";
import type { Palette } from "./palette.js";
import type { StoryFrameLayout } from "./story-frame-layout.js";
import {
  frameStyledText,
  sliceFrame,
  splitFrame,
  visibleWidth,
  type FrameLine,
  type FrameRegion
} from "./screens/story/frame.js";

/** The app owns viewport scrolling. TextRenderable's independent scroll
 * offset would move pixels away from the hit map built for the same frame. */
class StoryTextRenderable extends TextRenderable {
  protected override onMouseEvent(): void {}
}

export interface StorySurfacePaintOptions {
  pageSelectable?: boolean;
  /** Keep the full frame in one native TextBuffer so a projection built for
   * full-width modal input uses the same row stride as OpenTUI selection. */
  singleSelectionBuffer?: boolean;
}

export interface StorySurface {
  paint(
    frame: readonly FrameLine[],
    palette: Palette,
    layout: StoryFrameLayout,
    selectable: FrameRegion | null,
    options?: StorySurfacePaintOptions
  ): void;
  /** Toggle selection across every renderable carrying projected page cells. */
  setPageSelectable(selectable: boolean): void;
  setBackground(color: ColorInput): void;
  onMouse(handler: (event: MouseEvent) => void): void;
}

/** Keep the rail out of prose selection. Both buffers still consume slices
 * of the same frame, so overlays and styling stay pixel-identical. */
export function createStorySurface(renderer: CliRenderer, palette: Palette): StorySurface {
  let selectionEnabled = true;
  const page = new StoryTextRenderable(renderer, {
    id: "story",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    wrapMode: "none",
    bg: palette.color("background"),
    selectionBg: palette.color("focus / accent"),
    selectionFg: palette.color("background")
  });
  const rail = new StoryTextRenderable(renderer, {
    id: "story-rail",
    position: "absolute",
    left: 0,
    top: 0,
    width: 1,
    height: "100%",
    wrapMode: "none",
    selectable: false,
    visible: false,
    bg: palette.color("background")
  });
  const overlayRail = new StoryTextRenderable(renderer, {
    id: "story-overlay-rail",
    position: "absolute",
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    wrapMode: "none",
    visible: false,
    bg: palette.color("background")
  });
  renderer.root.add(page);
  renderer.root.add(rail);
  renderer.root.add(overlayRail);
  const boundaryGlyphs: StoryTextRenderable[] = [];
  let background = palette.color("background");
  let mouseHandler: ((event: MouseEvent) => void) | null = null;
  let lastFrame: readonly FrameLine[] | null = null;
  let lastPalette: Palette | null = null;
  let lastRailStart: number | null = null;
  let lastSelectable: FrameRegion | null = null;
  let lastPageFrame: readonly FrameLine[] | null = null;
  let lastRailFrame: readonly FrameLine[] | null = null;
  let lastPageSelectable = true;

  const setSelectionEnabled = (enabled: boolean) => {
    selectionEnabled = enabled;
    page.selectable = enabled;
    overlayRail.selectable = enabled;
    for (const glyph of boundaryGlyphs) glyph.selectable = enabled;
  };

  const boundaryGlyph = (index: number) => {
    const existing = boundaryGlyphs[index];
    if (existing !== undefined) return existing;
    const glyph = new StoryTextRenderable(renderer, {
      id: `story-boundary-glyph-${index}`,
      position: "absolute",
      left: 0,
      top: 0,
      width: 1,
      height: 1,
      wrapMode: "none",
      selectable: selectionEnabled,
      visible: false,
      bg: background
    });
    if (mouseHandler !== null) glyph.onMouse = mouseHandler;
    renderer.root.add(glyph);
    boundaryGlyphs.push(glyph);
    return glyph;
  };

  return {
    paint(frame, activePalette, layout, selectable, options) {
      const railStart = options?.singleSelectionBuffer === true
        ? null
        : layout.railStart;
      const pageSelectable = options?.pageSelectable ?? true;
      const paletteChanged = lastPalette !== activePalette;
      if (!paletteChanged && lastRailStart === railStart
        && lastPageSelectable === pageSelectable
        && sameRegion(lastSelectable, selectable) && sameFrame(lastFrame, frame)) return;
      setSelectionEnabled(pageSelectable);
      if (paletteChanged) {
        page.selectionBg = activePalette.color("focus / accent");
        page.selectionFg = activePalette.color("background");
      }
      if (railStart === null) {
        page.width = "100%";
        if (paletteChanged || !sameFrame(lastPageFrame, frame)) {
          page.content = frameStyledText(frame, activePalette);
        }
        rail.visible = false;
        overlayRail.visible = false;
        for (const glyph of boundaryGlyphs) glyph.visible = false;
        lastFrame = frame;
        lastPalette = activePalette;
        lastRailStart = railStart;
        lastSelectable = selectable;
        lastPageFrame = frame;
        lastRailFrame = null;
        lastPageSelectable = pageSelectable;
        return;
      }
      const railWidth = Math.max(1, layout.fullWidth - railStart);
      const [pageFrame, railFrame, boundaryFrames] = splitFrame(frame, railStart);
      const pageChanged = paletteChanged || !sameFrame(lastPageFrame, pageFrame);
      const railChanged = paletteChanged || !sameFrame(lastRailFrame, railFrame);
      const boundaryPaints = boundaryFrames.map((glyph) => ({
        ...glyph,
        width: visibleWidth(glyph.line[0]?.text ?? ""),
        content: frameStyledText([glyph.line], activePalette)
      }));
      const boundaryRenderables = boundaryPaints.map((_, index) => boundaryGlyph(index));
      const overlay = selectable === null ? null : intersectRail(selectable, railStart, layout.fullWidth);
      const overlayPaint = overlay === null ? null : {
        ...overlay,
        content: frameStyledText(
          sliceFrame(frame.slice(overlay.top, overlay.bottom), overlay.left, overlay.right - overlay.left),
          activePalette
        )
      };
      page.width = railStart;
      if (pageChanged) page.content = frameStyledText(pageFrame, activePalette);
      rail.left = railStart;
      rail.width = railWidth;
      if (railChanged) rail.content = frameStyledText(railFrame, activePalette);
      rail.visible = true;
      if (overlayPaint === null) {
        overlayRail.visible = false;
      } else {
        overlayRail.left = overlayPaint.left;
        overlayRail.top = overlayPaint.top;
        overlayRail.width = overlayPaint.right - overlayPaint.left;
        overlayRail.height = overlayPaint.bottom - overlayPaint.top;
        overlayRail.content = overlayPaint.content;
        overlayRail.visible = true;
      }
      for (const [index, paint] of boundaryPaints.entries()) {
        const glyph = boundaryRenderables[index]!;
        glyph.left = paint.left;
        glyph.top = paint.row;
        glyph.width = paint.width;
        glyph.content = paint.content;
        glyph.visible = true;
      }
      for (let index = boundaryPaints.length; index < boundaryGlyphs.length; index += 1) {
        boundaryGlyphs[index]!.visible = false;
      }
      // A renderable setter may throw after earlier setters already changed
      // pixels. Commit memoization only after the whole surface succeeds so an
      // identical retry repaints every region from the last complete frame.
      lastFrame = frame;
      lastPalette = activePalette;
      lastRailStart = railStart;
      lastSelectable = selectable;
      lastPageFrame = pageFrame;
      lastRailFrame = railFrame;
      lastPageSelectable = pageSelectable;
    },
    setPageSelectable(selectable) {
      setSelectionEnabled(selectable);
      lastPageSelectable = selectable;
    },
    setBackground(color) {
      background = color;
      page.bg = color;
      page.selectionFg = color;
      rail.bg = color;
      overlayRail.bg = color;
      for (const glyph of boundaryGlyphs) glyph.bg = color;
    },
    onMouse(handler) {
      mouseHandler = handler;
      page.onMouse = handler;
      rail.onMouse = handler;
      overlayRail.onMouse = handler;
      for (const glyph of boundaryGlyphs) glyph.onMouse = handler;
    }
  };
}

function sameRegion(left: FrameRegion | null, right: FrameRegion | null): boolean {
  return left === right || (left !== null && right !== null
    && left.left === right.left && left.top === right.top && left.right === right.right && left.bottom === right.bottom);
}

function sameFrame(left: readonly FrameLine[] | null, right: readonly FrameLine[]): boolean {
  if (left === null || left.length !== right.length) return false;
  for (let row = 0; row < right.length; row += 1) {
    const aLine = left[row]!;
    const bLine = right[row]!;
    if (aLine.length !== bLine.length) return false;
    for (let segmentIndex = 0; segmentIndex < bLine.length; segmentIndex += 1) {
      const a = aLine[segmentIndex]!;
      const b = bLine[segmentIndex]!;
      if (a.text !== b.text || a.role !== b.role || a.background !== b.background || a.bold !== b.bold) return false;
    }
  }
  return true;
}

function intersectRail(region: FrameRegion, railStart: number, width: number): FrameRegion | null {
  const left = Math.max(region.left, railStart);
  const right = Math.min(region.right, width);
  return right <= left ? null : { ...region, left, right };
}
