import { describe, expect, test } from "bun:test";
import { appendContinuationText } from "../../shared/story-text.js";
import { switchToNode } from "../../shared/story-tree.js";
import type { Story, StoryNode, StoryPayload } from "../../shared/types.js";
import { buildStoryPayload } from "../../server/story-payload.js";
import { createDemoController } from "../src/demo.js";
import type { HitRows, HitTarget } from "../src/hit.js";
import type { MapState, MapView } from "../src/map-state.js";
import { movePathCursor } from "../src/path-layout.js";
import { renderMapScreen } from "../src/screens/map.js";
import { frameText, plainLine, visibleWidth } from "../src/screens/story/frame.js";
import type { StoryScreenState } from "../src/state.js";
import { projectStreamedPayload } from "../src/stream-projection.js";

const NOW = 1_667_000_000_000;
const STREAM_STARTED_AT = "2026-07-22T00:00:00.000Z";

function state(): StoryScreenState {
  return {
    payload: createDemoController().payload(),
    now: NOW,
    stream: null
  } as StoryScreenState;
}

function map(view: MapView, source: StoryScreenState, extra: Partial<MapState> = {}): MapState {
  const leaf = source.payload.path.at(-1)!.id;
  return {
    view,
    pathCursorId: leaf,
    pathShowAllTakes: true,
    treeCursorId: leaf,
    rowIds: [],
    showSketches: false,
    openedColdFolds: new Set(),
    massSort: "size",
    ...extra
  };
}

function render(view: MapView, width = 80, height = 24, extra: Partial<MapState> = {}) {
  const source = state();
  const mapState = map(view, source, extra);
  const hits: HitRows = [];
  const frame = renderMapScreen(source, mapState, width, height, hits);
  return { source, mapState, frame, hits, text: frameText(frame.lines) };
}

function targets(hits: HitRows): HitTarget[] {
  return hits.flatMap((row) => row === null
    ? [] : [row.target, ...row.overrides?.map((override) => override.target) ?? []]);
}

function activityStory(): Story {
  const old = "2000-01-01T00:00:00.000Z";
  const other = "2025-01-01T00:00:00.000Z";
  const node = (
    id: string, parentId: string | null, activeChildId: string | null, createdAt: string
  ): StoryNode => ({
    id, parentId, activeChildId, createdAt,
    instruction: `write ${id}`, text: `${id} prose`, model: "test"
  });
  return {
    id: "old-activity", title: "old activity", createdAt: old, updatedAt: other,
    nodes: [
      node("root", null, "active-one", old),
      node("active-one", "root", "active-leaf", old),
      node("active-leaf", "active-one", null, old),
      node("other-one", "root", "other-leaf", other),
      node("other-leaf", "other-one", null, other)
    ],
    activeRootId: "root", tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
}

/** One shown line, one alternate that keeps writing, one alternate that stopped. */
function branchingStory(): Story {
  const at = "2026-01-01T00:00:00.000Z";
  const node = (id: string, parentId: string | null, activeChildId: string | null): StoryNode => ({
    id, parentId, activeChildId, createdAt: at,
    instruction: `write ${id}`, text: `${id} prose`, model: "test"
  });
  return {
    id: "branching", title: "branching", createdAt: at, updatedAt: at,
    nodes: [
      node("root", null, "near"),
      node("near", "root", "near-leaf"),
      node("near-leaf", "near", null),
      node("kept", "root", "kept-leaf"),
      node("kept-leaf", "kept", null),
      node("far", "root", null)
    ],
    activeRootId: "root", tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
}

function landedActivity(story: Story, stream: NonNullable<StoryScreenState["stream"]>): StoryPayload {
  const landed = structuredClone(story);
  if (stream.append) {
    const target = landed.nodes.find((node) => node.id === stream.targetId)!;
    target.text = appendContinuationText(target.text, stream.text);
    target.updatedAt = stream.startedAt;
  } else {
    landed.nodes.push({
      id: stream.targetId, parentId: stream.parentId,
      instruction: stream.instruction, text: stream.text.trim(), model: "writing",
      createdAt: stream.startedAt, activeChildId: null
    });
    switchToNode(landed, stream.targetId);
  }
  return buildStoryPayload(landed);
}

describe("full-bleed map screen", () => {
  test("shares one spatial shell at 80x24 and 120x36", () => {
    for (const view of ["path", "tree", "mass"] as const) {
      for (const [width, height] of [[80, 24], [120, 36]] as const) {
        const rendered = render(view, width, height);
        expect(rendered.frame.lines).toHaveLength(height);
        expect(rendered.hits).toHaveLength(height);
        expect(rendered.frame.selectable).toBe(null);
        expect(rendered.text).toContain("━━ map ·");
        expect(plainLine(rendered.frame.lines.at(-1)!)).toContain(" MAP ");
        expect(plainLine(rendered.frame.lines.at(-1)!)).toContain(rendered.source.payload.title.slice(0, 5));
        expect(rendered.text).not.toContain("┏━");
        expect(rendered.text).not.toContain("j/k");
        expect(rendered.text).not.toContain("h/l");
        expect(rendered.frame.lines.flat().every((part) => part.background !== "raised")).toBeTrue();
        expect(targets(rendered.hits).every((target) => target.kind !== "scrim" && target.kind !== "panel")).toBeTrue();
        for (const line of rendered.frame.lines) expect(visibleWidth(plainLine(line)) <= width).toBeTrue();

        const tabs = rendered.frame.lines[0]!.filter((part) => ["path", "tree", "mass"].includes(part.text.trim()));
        expect(tabs).toHaveLength(3);
        for (const tab of tabs) {
          expect(tab.text.trim() === view ? tab.background : tab.role)
            .toBe(tab.text.trim() === view ? "focus / accent" : "dimmed page");
        }
      }
    }
  });

  test("path exposes depth rows and exact sibling-take hit regions", () => {
    const rendered = render("path", 80, 24, { showSketches: true });
    expect(rendered.text).toContain("depth 1–13 of 13");
    expect(rendered.text).toContain("↑↓ depth · ←→ take");
    expect(rendered.frame.derived.pathCursorId).toBe(rendered.mapState.pathCursorId);
    expect(rendered.frame.derived.rowIds).toHaveLength(13);

    const rowTargets = targets(rendered.hits).filter((target) => target.kind === "list");
    expect(rowTargets).toHaveLength(rendered.frame.derived.rowIds.length);
    const takeTargets = targets(rendered.hits).filter((target) => target.kind === "take");
    expect(takeTargets.length > 0).toBeTrue();
    expect(takeTargets.some((target) => target.kind === "take" && target.take === 3)).toBeTrue();
    expect(rendered.text).toContain("◉");
    expect(rendered.text).not.toContain("●⟳");
  });

  test("rings the takes that have subtakes and leaves the cursor's own take plain", () => {
    const source = { payload: buildStoryPayload(branchingStory()), now: NOW, stream: null } as StoryScreenState;
    const glyphColumn = (showAllTakes: boolean): string[] => {
      const hits: HitRows = [];
      const frame = renderMapScreen(
        source, map("path", source, { pathCursorId: "root", pathShowAllTakes: showAllTakes }), 120, 36, hits
      );
      return frameText(frame.lines).split("\n").filter((line) => /^\s+¶\s+\d/.test(line))
        .map((line) => line.replace(/^\s+¶\s+\d+\s+/, "").split(/\s{2,}/)[0]!);
    };

    // Depth 1 is the cursor: `root` branches three ways and still renders plain.
    // Depth 2 separates a continued alternate (◎) from a lone one (○); depth 3
    // is the shown line's leaf, which has no inside to promise.
    expect(glyphColumn(true)).toEqual(["▸●", "◉─◎─○", "●"]);
    // Folded sketches are not an inside you can open, so `far` disappears with them.
    expect(glyphColumn(false)).toEqual(["▸●", "◉─◎", "●"]);
  });

  test("never paints a row through a take it is folding away", () => {
    // `kept` remembers `kept-sketch`, a lone childless take the map folds. The
    // rows below `kept` must follow the take it will actually paint, or the
    // preview names a part the reader has no way to reach.
    const story = branchingStory();
    const extra = (id: string, parentId: string): StoryNode => ({
      id, parentId, activeChildId: null, createdAt: story.createdAt,
      instruction: `write ${id}`, text: `${id} prose`, model: "test"
    });
    story.nodes.push(extra("kept-sketch", "kept"), extra("kept-deep", "kept-leaf"));
    story.nodes.find((node) => node.id === "kept")!.activeChildId = "kept-sketch";
    const source = { payload: buildStoryPayload(story), now: NOW, stream: null } as StoryScreenState;
    const shown = (showAllTakes: boolean): string[] => {
      const hits: HitRows = [];
      const frame = renderMapScreen(
        source, map("path", source, { pathCursorId: "kept", pathShowAllTakes: showAllTakes }), 120, 36, hits
      );
      return frameText(frame.lines).split("\n").filter((line) => /^\s+¶\s+\d/.test(line))
        .map((line) => line.replace(/^\s+¶\s+\d+\s+/, ""));
    };

    const folded = shown(false);
    expect(folded).toHaveLength(4);
    expect(folded.join("\n")).toContain("kept-deep prose");
    expect(folded.join("\n")).not.toContain("kept-sketch prose");
    expect(movePathCursor(source.payload, "kept", 1, 0)).toBe("kept-leaf");

    // Revealing sketches makes the remembered take reachable, so it returns.
    const revealed = shown(true);
    expect(revealed).toHaveLength(3);
    expect(revealed.join("\n")).toContain("kept-sketch prose");
    expect(movePathCursor(source.payload, "kept", 1, 0, true)).toBe("kept-sketch");
  });

  test("a ring on a stopped line still opens", () => {
    // `stopAtNode` clears the endpoint's activeChildId, so the node remembers
    // itself as its own leaf while its takes remain. The ring may not promise
    // an inside the map refuses to open.
    const demo = createDemoController();
    const source = { payload: demo.switchTo("p11", { stopAtNode: true }), now: NOW, stream: null } as StoryScreenState;
    const depths = (cursor: string): string[] => {
      const hits: HitRows = [];
      const frame = renderMapScreen(source, map("path", source, {
        pathCursorId: cursor,
        pathShowAllTakes: false
      }), 120, 36, hits);
      return frameText(frame.lines).split("\n").filter((line) => /^\s+¶\s+\d/.test(line));
    };

    expect(source.payload.path.at(-1)!.id).toBe("p11");
    expect(depths("p10").at(-3)).toContain("◉");
    expect(depths("p10")).toHaveLength(13);
    expect(depths("p11")).toHaveLength(13);
    expect(movePathCursor(source.payload, "p11", 1, 0)).toBe("p12");
  });

  test("projects a direct stream into every map view before it lands", () => {
    const source = state();
    const targetId = "stream-map-take";
    source.stream = {
      targetId,
      parentId: "p7",
      append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: "Follow the flooded road.",
      text: "  A virtual current crossed the map.  ",
      partNumber: 8
    };

    for (const view of ["path", "tree", "mass"] as const) {
      const hits: HitRows = [];
      const frame = renderMapScreen(source, map(view, source, {
        pathCursorId: targetId,
        treeCursorId: targetId
      }), 120, 36, hits);
      expect(frame.derived.rowIds).toContain(targetId);
      expect(frameText(frame.lines)).toContain("A virtual current crossed the map.");
    }

    const pathHits: HitRows = [];
    const path = renderMapScreen(source, map("path", source, {
      pathCursorId: targetId,
      treeCursorId: targetId
    }), 120, 36, pathHits);
    expect(frameText(path.lines)).toContain("◌");
    expect(frameText(path.lines)).toContain("6w+");
    expect(frameText(path.lines)).not.toContain("●⟳");

    // A StreamView is replaced, never rewritten (state.ts); a pending stream
    // is a fresh claim object, not the substantive one with its text removed.
    source.stream = { ...source.stream, text: "" };
    const pending = renderMapScreen(source, map("path", source, {
      pathCursorId: targetId,
      treeCursorId: targetId
    }), 120, 36, []);
    expect(pending.derived.rowIds).toContain(targetId);
    expect(frameText(pending.lines)).toContain("0w+");
  });

  test("stream projection updates parent and ancestor map rollups", () => {
    const source = state();
    const parentId = "p7";
    const targetId = "stream-rollup";
    source.stream = {
      targetId,
      parentId,
      append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: "Branch once more.",
      text: "The extra branch landed.",
      partNumber: 8
    };
    const beforeParent = source.payload.nodes.find((node) => node.id === parentId)!;
    expect(beforeParent.childCount).toBeGreaterThan(0);

    const projected = projectStreamedPayload(source.payload, source.stream, { includePendingTake: true });
    expect(projected.tags).toEqual(source.payload.tags);
    const afterParent = projected.nodes.find((node) => node.id === parentId)!;
    expect(afterParent).toMatchObject({
      activeChildId: targetId,
      childCount: beforeParent.childCount + 1,
      leafCount: beforeParent.leafCount + 1
    });
    for (const ancestor of source.payload.path.slice(0, 7)) {
      const before = source.payload.nodes.find((node) => node.id === ancestor.id)!;
      const after = projected.nodes.find((node) => node.id === ancestor.id)!;
      expect(after.leafCount).toBe(before.leafCount + 1);
    }
    expect(projected.path.at(-1)?.id).toBe(targetId);
    expect(projected.nodes.find((node) => node.id === targetId)).toMatchObject({
      parentId,
      childCount: 0,
      leafCount: 1
    });
  });

  test("stream-start activity drives recent MAP order and matches authoritative landing", () => {
    const story = activityStory();
    const payload = buildStoryPayload(story);
    const settled = { payload, now: Date.parse(STREAM_STARTED_AT), stream: null } as StoryScreenState;
    const before = renderMapScreen(settled, map("mass", settled, {
      massSort: "recency", treeCursorId: "active-leaf"
    }), 120, 36, []);
    expect(before.derived.rowIds[0]).toBe("other-leaf");

    const streams: Array<NonNullable<StoryScreenState["stream"]>> = [
      {
        targetId: "active-leaf", parentId: "active-one", append: true,
        startedAt: STREAM_STARTED_AT, instruction: "", text: " arriving now"
      },
      {
        targetId: "stream-new-leaf", parentId: "active-leaf", append: false,
        startedAt: STREAM_STARTED_AT, instruction: "Cross the old threshold.", text: "A new line arrived."
      }
    ];

    for (const stream of streams) {
      const projected = projectStreamedPayload(payload, stream, { includePendingTake: true });
      const landed = landedActivity(story, stream);
      const activityShape = (source: StoryPayload) => source.nodes.map((node) => ({
        id: node.id, lastTouched: node.lastTouched, updatedAt: node.updatedAt ?? null
      }));
      const pathShape = (source: StoryPayload) => source.path.map((node) => ({
        id: node.id, createdAt: node.createdAt, updatedAt: node.updatedAt ?? null
      }));

      expect(activityShape(projected)).toEqual(activityShape(landed));
      expect(pathShape(projected)).toEqual(pathShape(landed));
      expect(projected.recentNodeIds).toEqual(landed.recentNodeIds);
      for (const ancestorId of ["root", "active-one", "active-leaf"]) {
        expect(projected.nodes.find((node) => node.id === ancestorId)?.lastTouched)
          .toBe(STREAM_STARTED_AT);
      }

      const source = { payload, now: Date.parse(STREAM_STARTED_AT), stream } as StoryScreenState;
      const frame = renderMapScreen(source, map("mass", source, {
        massSort: "recency", treeCursorId: stream.targetId
      }), 120, 36, []);
      expect(frame.derived.rowIds[0]).toBe(stream.targetId);
      expect(frameText(frame.lines)).toContain("unnamed · 22 jul");
    }
  });

  test("a streamed child carries the active line-end tag in every map view", () => {
    const demo = createDemoController();
    const source = { payload: demo.payload(), now: NOW, stream: null } as StoryScreenState;
    const leafId = source.payload.path.at(-1)!.id;
    const targetId = "stream-tagged-child";
    source.stream = {
      targetId,
      parentId: leafId,
      append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: "Cross the chapter boundary.",
      text: "The named line continued beyond the break."
    };

    const projected = projectStreamedPayload(source.payload, source.stream, { includePendingTake: true });
    expect(source.payload.tags.find((tag) => tag.name === "canon-storm")?.nodeId).toBe(leafId);
    expect(projected.tags.find((tag) => tag.name === "canon-storm")?.nodeId).toBe(targetId);
    const landed = demo.createChild(leafId, source.stream.instruction, source.stream.text);
    expect(landed.tags.find((tag) => tag.name === "canon-storm")?.nodeId)
      .toBe(landed.path.at(-1)?.id);

    for (const view of ["path", "tree", "mass"] as const) {
      const frame = renderMapScreen(source, map(view, source, {
        pathCursorId: targetId,
        treeCursorId: targetId
      }), 120, 36, []);
      expect(frameText(frame.lines)).toContain("canon-storm");
    }
  });

  test("deep paths use the full body because childless takes stay visible", () => {
    const demo = createDemoController();
    let payload = demo.payload();
    for (let depth = 14; depth <= 40; depth += 1) {
      payload = demo.createChild(payload.path.at(-1)!.id, `continue ${depth}`, `continued part ${depth}`);
    }
    const source = { payload, now: NOW, stream: null } as StoryScreenState;
    const mapState = map("path", source);
    const hits: HitRows = [];
    const frame = renderMapScreen(source, mapState, 80, 24, hits);

    expect(frameText(frame.lines)).not.toContain("sketches folded");
    expect(targets(hits).filter((target) => target.kind === "list")).toHaveLength(20);
  });

  test("path keeps trailing metadata after a full-width preview", () => {
    const source = state();
    const leaf = source.payload.path.at(-1)!;
    const stub = source.payload.nodes.find((node) => node.id === leaf.id)!;
    stub.preview = "界".repeat(40);
    const hits: HitRows = [];
    const frame = renderMapScreen(source, map("path", source), 120, 36, hits);
    const row = frame.lines.find((line) => plainLine(line).includes("界"))!;
    expect(plainLine(row)).toContain(`${stub.words}w`);
    expect(visibleWidth(plainLine(row)) <= 120).toBeTrue();
  });

  test("path aligns word metadata independently of tag badges", () => {
    const rendered = render("path", 120, 36);
    const positions = rendered.frame.lines.flatMap((line) => {
      const wordIndex = line.findIndex((part) => /^\s*\d+w\+?$/.test(part.text));
      if (wordIndex < 0) return [];
      const wordColumn = line.slice(0, wordIndex)
        .reduce((sum, part) => sum + visibleWidth(part.text), 0);
      const tagged = line.some((part) => part.role === "tag · canon" && part.text.trim() !== "");
      return [{ wordColumn, tagged }];
    });
    expect(positions.some((item) => item.tagged)).toBeTrue();
    expect(positions.some((item) => !item.tagged)).toBeTrue();
    expect(new Set(positions.map((item) => item.wordColumn)).size).toBe(1);
    const draftFrame = render("path", 120, 36, { pathCursorId: "p5-alt" });
    const draft = draftFrame.frame.lines.flat().find((part) => part.text.includes("draft-ledger"));
    expect(draft?.role).toBe("tag · draft");
  });

  test("breadcrumb preserves the active tag's glyph and semantic role", () => {
    const demo = createDemoController();
    const source = {
      payload: demo.switchTo("p5-alt", { stopAtNode: true }),
      now: NOW,
      stream: null
    } as StoryScreenState;
    const hits: HitRows = [];
    const frame = renderMapScreen(source, map("path", source), 120, 36, hits);
    const breadcrumb = frame.lines.at(-1)!;
    const identity = breadcrumb.find((part) => part.text.includes("~ draft-ledger"));

    expect(identity?.role).toBe("tag · draft");
  });

  test("tree keeps graph rows clickable and drops preview only at narrow geometry", () => {
    const narrow = render("tree");
    expect(narrow.text).toContain("⋯ 1 part");
    expect(narrow.text).toContain("↑↓ row · l follow");
    expect(narrow.text).toContain("sketches");
    expect(narrow.text).not.toContain("  ‥ ");
    const rowTargets = targets(narrow.hits).filter((target) => target.kind === "list");
    expect(rowTargets).toHaveLength(narrow.frame.derived.rowIds.length);
    expect(narrow.frame.derived.rowIds).toContain(narrow.frame.derived.treeCursorId);

    const wide = render("tree", 120, 36);
    expect(wide.text).toContain("  ‥ ");
  });

  test("mass is a first-class weighted view with all four sort states", () => {
    // Doc 26a dropped the in-canvas `sort:` row — the footer already says
    // `s sort`, so the title rule is the only place the order is named.
    const titles = {
      size: ["largest first", "largest"], recency: ["recent first", "recent"],
      depth: ["deepest first", "deepest"], name: ["alphabetical", "alpha"]
    } as const;
    for (const [sort, [title, short]] of
      Object.entries(titles) as Array<[MapState["massSort"], readonly [string, string]]>) {
      const rendered = render("mass", 80, 24, { massSort: sort });
      expect(rendered.text).toContain("◉");
      expect(rendered.text).toContain("← here");
      expect(rendered.text).toContain("sketches");
      expect(rendered.text).toContain("never continued");
      expect(rendered.text).not.toContain("sort: ");
      expect(rendered.text).toContain("s sort");
      expect(plainLine(render("mass", 120, 36, { massSort: sort }).frame.lines[0]!)).toContain(title);
      // The title rule is the only place the active order is named, so it has
      // to survive the narrow layout too — abbreviated rather than truncated.
      const narrowTitle = plainLine(rendered.frame.lines[0]!);
      expect(narrowTitle).toContain(short);
      expect(narrowTitle).not.toContain("…");
      expect(rendered.text).not.toContain("  ‥ ");
      expect(targets(rendered.hits).filter((target) => target.kind === "list"))
        .toHaveLength(rendered.frame.derived.rowIds.length);
    }
  });

  test("the mass header counts the story once, not the shared trunk per line", () => {
    // Summing each line's cumulative words counted the trunk once per line and
    // claimed far more prose than the story holds (doc 26a).
    const rendered = render("mass", 120, 36);
    const header = plainLine(rendered.frame.lines[0]!);
    expect(header).toContain("466 words · 4 lines");
    expect(header).not.toContain("653");
  });

  test("mass preserves identity and the numeric crumb at medium width", () => {
    const narrow = render("mass", 80, 24);
    const medium = render("mass", 120, 36);
    const wide = render("mass", 150, 36);
    const narrowCrumb = plainLine(narrow.frame.lines.at(-1)!);
    const mediumCrumb = plainLine(medium.frame.lines.at(-1)!);
    const wideCrumb = plainLine(wide.frame.lines.at(-1)!);

    expect(narrowCrumb).toContain("the la… · ⚑ cano… · ¶13·466w");
    expect(narrowCrumb).not.toContain("¶13·4…");
    expect(narrowCrumb).toContain("m path · ↑↓ row · s sort · l open · esc");
    expect(mediumCrumb).toContain("the lantern keeper · ⚑ canon-storm · ¶ 13 · 466 words");
    expect(mediumCrumb).toContain("m path · ↑↓ row · s sort · l open · esc writes");
    expect(mediumCrumb).not.toContain("enter reroute");
    expect(wideCrumb).toContain("the lantern keeper · ⚑ canon-storm · ¶ 13 · 466 words");
    expect(wideCrumb).toContain("l open line · enter reroute · esc writes");
  });

  test("returns canonical cursor fallbacks for integration ownership", () => {
    const tree = render("tree", 80, 24, { treeCursorId: "missing" });
    expect(tree.frame.derived.treeCursorId).toBe(tree.source.payload.path.at(-1)!.id);
    expect(tree.frame.derived.rowIds).toContain(tree.frame.derived.treeCursorId);

    const path = render("path", 80, 24, { pathCursorId: "missing" });
    expect(path.frame.derived.pathCursorId).toBe(path.source.payload.path.at(-1)!.id);
    expect(path.frame.derived.rowIds).toContain(path.frame.derived.pathCursorId);
  });

  test("replaces the MAP breadcrumb with an unmistakable prune confirmation", () => {
    const source = state();
    source.prune = {
      kind: "subtree",
      nodeId: source.payload.path.at(-1)!.id,
      part: 13,
      take: 3,
      takeCount: 5,
      parts: 2,
      lines: 1,
      tags: [{ name: "canon-storm", status: "Canon" }]
    };
    for (const [width, height] of [[80, 24], [120, 36]] as const) {
      const hits: HitRows = [];
      const frame = renderMapScreen(source, map("path", source), width, height, hits);
      const status = frame.lines.at(-1)!;
      expect(status[0]).toMatchObject({ text: " PRUNE ", background: "danger", bold: true });
      expect(plainLine(status)).toContain("¶ 13 take 3/5");
      expect(plainLine(status)).toContain("d confirms · esc keeps");
      expect(plainLine(status)).not.toContain("m tree");
    }
  });

  test("keeps backend ownership visible in the full-bleed map", () => {
    const source = state();
    source.backendTask = {
      id: 7,
      kind: "action",
      label: "switching take",
      storyId: source.payload.id
    };
    const frame = renderMapScreen(source, map("tree", source), 120, 36, []);
    expect(plainLine(frame.lines.at(-1)!)).toContain(" MAP   working · switching take");
  });
});
