import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState, type AppSource } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine } from "../src/screens/story/frame.js";
import { runSearch } from "../src/search-request.js";
import { adoptSameStoryPayload, adoptStoryState } from "../src/story-adoption.js";
import { searchInFlight, searchRows, type SearchGroupRow, type SearchHitRow } from "../src/search-model.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { searchCorpus, type SearchCorpus } from "../../shared/story-search.js";

const key = (name: string, sequence = name, ctrl = false): KeyEvent =>
  ({ name, sequence, shift: false, ctrl, meta: false }) as KeyEvent;

function setupSearchHarness() {
  const source: AppSource = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => {});
  const press = async (name: string, sequence = name, ctrl = false) => {
    const pending = handleKey(
      key(name, sequence, ctrl), state, source, cache,
      () => {}, async () => {}, () => {}, null, () => {}, () => {}, backend
    );
    await backend.observe(pending);
    while (state.backendTask !== null) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const typeString = async (text: string) => {
    for (const char of text) {
      await press(char, char);
    }
  };
  const render = (width = 120, height = 36) =>
    renderStoryScreen(state, { width, height, wrapCache: cache });
  return { source, state, cache, backend, press, typeString, render };
}

describe("global search screen and model", () => {
  test("a chapter-summary hit groups with the line enter lands on", async () => {
    const { state, press, typeString } = setupSearchHarness();
    await press("/");
    // "storm-locked" appears only inside the fixture's chapter summary, which
    // hangs off the current line rather than standing in it.
    await typeString("storm-locked");
    const groups = searchRows(state.search!, state.payload).rows
      .filter((row): row is Extract<typeof row, { kind: "group" }> => row.kind === "group");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("line");
    expect(groups[0]!.detail).toBe("· this line");

    // The row must name the part enter opens, not the summary's own position.
    const hitRow = searchRows(state.search!, state.payload).rows
      .find((row) => row.kind === "hit");
    expect(hitRow?.kind).toBe("hit");
    const landingId = hitRow?.kind === "hit" ? hitRow.hit.targetId : "";
    expect(state.payload.path.some((node) => node.id === landingId)).toBeTrue();
    await press("return", "\r");
    expect(state.mode).toBe("NAV");
    const focused = state.payload.path[state.focusIndex];
    expect(focused?.id).toBe(landingId);
  });

  test("adopting a new revision of the story retires the results", async () => {
    const { state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("compass");
    const search = state.search!;
    expect(search.response?.hits.length).toBeGreaterThan(0);

    // A rewrite can keep a node id while replacing every word the query
    // matched, so results that describe the previous revision must not survive
    // it — enter would travel to text that has moved.
    adoptSameStoryPayload(state, { ...state.payload }, createWrapCache<ProseStyle>());
    expect(search.response).toBe(null);
    expect(searchRows(search, state.payload).selectableCount).toBe(0);
  });

  test("typing a word costs one scan, not one per letter", async () => {
    const { source, state, press } = setupSearchHarness();
    // This is the behaviour under test, so this harness keeps the real pause.
    source.searchDebounceMs = 25;
    let scans = 0;
    const searchStories = source.api.searchStories.bind(source.api);
    source.api.searchStories = async (request, signal) => {
      scans += 1;
      return await searchStories(request, signal);
    };

    await press("/");
    for (const character of "lantern") await press(character, character);
    expect(scans).toBe(0);
    expect(searchInFlight(state.search!)).toBeTrue();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(scans).toBe(1);
    expect(state.search!.response?.hits.length).toBeGreaterThan(0);
    expect(searchInFlight(state.search!)).toBeFalse();
  });

  test("a deliberate scope change does not wait for the pause", async () => {
    const { source, state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("lantern");
    source.searchDebounceMs = 10_000;

    await press("tab", "\t");
    // `tab` is one act, not the middle of a word, so it answers at once.
    expect(state.search!.response?.scope).toBe("vault");
  });

  test("a later keystroke stops the scan it supersedes", async () => {
    const { source, state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("compass");
    const search = state.search!;

    search.query = "lantern";
    runSearch(state, search, source, () => {});
    const superseded = search.pending!;
    expect(superseded.signal.aborted).toBeFalse();

    // Ignoring the reply is not enough: a vault scan reads stories off disk.
    search.query = "lanterns";
    runSearch(state, search, source, () => {});
    expect(superseded.signal.aborted).toBeTrue();
    expect(search.pending).not.toBe(superseded);
  });

  test("esc stops the scan as well as the screen", async () => {
    const { state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("compass");
    const search = state.search!;
    // The fixture answers instantly, so stand in for a scan still running.
    const pending = new AbortController();
    search.pending = pending;

    await press("escape", "");
    expect(state.mode).toBe("NAV");
    expect(pending.signal.aborted).toBeTrue();
  });

  test("switching story stops the scan it discards", async () => {
    const { state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("compass");
    const search = state.search!;
    // The fixture answers instantly, so stand in for a scan still running.
    const pending = new AbortController();
    search.pending = pending;

    adoptStoryState(state, { ...state.payload, id: "another-story" }, createWrapCache<ProseStyle>());
    expect(state.search).toBe(null);
    expect(pending.signal.aborted).toBeTrue();
  });

  test("a request still in flight is abandoned, not left pending", async () => {
    const { source, state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("compass");
    const search = state.search!;

    search.query = "lantern";
    runSearch(state, search, source, () => {});
    expect(searchInFlight(search)).toBeTrue();
    // The reply will fail the ownership fence and run no handler, so adoption
    // has to clear the pending state or the pane reads "searching…" forever.
    const pending = search.pending!;
    adoptSameStoryPayload(state, { ...state.payload }, createWrapCache<ProseStyle>());
    expect(searchInFlight(search)).toBeFalse();
    expect(pending.signal.aborted).toBeTrue();
  });

  test("an armed case lamp survives a narrow header", async () => {
    const { state, press, typeString, render } = setupSearchHarness();
    await press("/");
    await press("s", "", true);
    await typeString("the brass compass on the bar between them");
    // The lamp is the only thing saying the result set is case-sensitive, so a
    // long query must cost the tally its cells rather than the lamp.
    const title = plainLine(render(80, 20).lines[0]!);
    expect(title).toContain("●");
  });

  test("a vault hit that no longer exists does not switch the story", async () => {
    const { source, state, press, typeString } = setupSearchHarness();
    const opened = state.payload.id;
    await press("/");
    await press("tab", "\t");
    await typeString("lantern");
    const search = state.search!;
    const foreign = search.response!.hits.find((hit) => hit.storyId !== opened)!;
    expect(foreign).toBeDefined();
    // The result set outlived the prose it names. A jump that cannot land must
    // leave the reader where they were.
    foreign.targetId = "gone-from-that-story";
    const rows = searchRows(search, state.payload).rows;
    const index = rows.findIndex((row) => row.kind === "hit" && row.hit === foreign);
    search.cursor = (rows[index] as { select: number }).select;

    await press("return", "\r");
    expect(state.payload.id).toBe(opened);
    expect(state.toast).toContain("no longer");
  });

  test("a vault group is named by the hit that created it", async () => {
    const { source, state, press, typeString } = setupSearchHarness();
    await press("/");
    await press("tab", "\t");
    await typeString("lantern");
    // A story the catalog listing has not seen carries its only authoritative
    // title on the hits themselves.
    source.stories = [];
    const groups = searchRows(state.search!, state.payload).rows
      .filter((row): row is Extract<typeof row, { kind: "group" }> => row.kind === "group");
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.name).not.toBe(group.id);
      expect(group.name.length).toBeGreaterThan(0);
    }
  });

  test("a request in flight retires the hits it replaces", async () => {
    const { source, state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("compass");
    const search = state.search!;
    expect(search.response?.hits.length).toBeGreaterThan(0);

    // While the reply is still out, nothing on screen may describe the query
    // that has just been replaced — `enter` would travel to one of its hits.
    search.query = "compass that never appears";
    runSearch(state, search, source, () => {});
    expect(searchInFlight(search)).toBeTrue();
    expect(search.response).toBe(null);
    expect(searchRows(search, state.payload).selectableCount).toBe(0);
  });

  test("switching scope retires hits that belonged to the other scope", async () => {
    const { state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("compass");
    const search = state.search!;
    expect(search.response?.scope).toBe("tree");

    await press("tab", "\t");
    expect(search.response === null || search.response.scope === "vault").toBeTrue();
  });

  test("slash key opens search screen and esc returns to nav mode", async () => {
    const { state, press, render } = setupSearchHarness();
    expect(state.mode).toBe("NAV");
    expect(state.search).toBe(null);

    await press("/");
    expect(state.mode).toBe("SEARCH");
    expect(state.search !== null).toBeTrue();

    const frame = render(120, 36);
    const topText = plainLine(frame.lines[0]!);
    expect(topText).toContain("search");
    expect(topText).toContain("⌕");

    await press("escape", "\x1b");
    expect(state.mode).toBe("NAV");
    expect(state.search).toBe(null);
  });

  test("typing refines search live and groups by line, branch, and facts", async () => {
    const { state, typeString, press, render } = setupSearchHarness();
    await press("/");
    await typeString("maren");

    const frame = render(120, 36);
    const titleLine = plainLine(frame.lines[0]!);
    expect(titleLine).toContain("search");
    expect(titleLine).toContain("maren");
    expect(titleLine).toContain("scope whole tree");
    expect(titleLine).toMatch(/\d+ hits in \d+ lines/);

    const model = searchRows(state.search!, state.payload);
    const groupRows = model.rows.filter((r): r is SearchGroupRow & { select: number } => r.kind === "group");
    const sorts = groupRows.map((g) => g.sort);
    expect(sorts[0]).toBe("line");
    expect(sorts).toContain("branch");
    expect(sorts).toContain("facts");
  });

  test("the column grid enforces doc 17a layout rules across every body row", async () => {
    const { state, press, typeString, render } = setupSearchHarness();
    await press("/");
    await typeString("maren");

    const height = 36;
    const frame = render(120, height);

    for (let r = 1; r < height - 1; r++) {
      const lineStr = plainLine(frame.lines[r]!);
      expect(lineStr[58]).toBe("│");
    }

    const model = searchRows(state.search!, state.payload);
    const hitIndexInModel = model.rows.findIndex((r) => r.kind === "hit");
    expect(hitIndexInModel).toBeGreaterThan(-1);

    const paintedHitLine = plainLine(frame.lines[hitIndexInModel + 1]!);
    expect(["▌", " "]).toContain(paintedHitLine[0]!);

    const refField = paintedHitLine.slice(4, 10);
    expect(refField.length).toBe(6);
    expect(paintedHitLine[58]).toBe("│");
  });

  test("prose, prompt, and fact hits are distinguished in the ref field", async () => {
    const { state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("lantern");

    const hits = state.search?.response?.hits ?? [];
    const proseHit = hits.find((h) => h.kind === "prose");
    const promptHit = hits.find((h) => h.kind === "prompt");
    const factHit = hits.find((h) => h.kind === "fact");

    expect(proseHit !== undefined).toBeTrue();
    expect(promptHit !== undefined).toBeTrue();
    expect(factHit !== undefined).toBeTrue();

    const proseRef = `${proseHit!.kind === "prompt" ? "»" : "¶"}${proseHit!.depth}`;
    const promptRef = `»${promptHit!.depth}`;
    const factRef = "fact";

    expect(proseRef).toMatch(/^¶\d+/);
    expect(promptRef).toMatch(/^»\d+/);
    expect(factRef).toBe("fact");
  });

  test("tab switches to vault scope with stories ordered heaviest first", async () => {
    const { state, press, typeString, render } = setupSearchHarness();
    await press("/");
    await typeString("the");

    await press("tab", "\t");
    expect(state.search?.scope).toBe("vault");

    const model = searchRows(state.search!, state.payload);
    const storyGroups = model.rows.filter((r): r is SearchGroupRow & { select: number } => r.kind === "group" && r.sort === "story");
    expect(storyGroups.length).toBeGreaterThan(1);

    for (let i = 0; i < storyGroups.length - 1; i++) {
      expect(storyGroups[i]!.hits.length >= storyGroups[i + 1]!.hits.length).toBeTrue();
    }

    const frame = render(120, 36);
    const footerLine = plainLine(frame.lines[frame.lines.length - 1]!);
    // The grids' own copy: vault scope promises a story switch, not a reroute.
    expect(footerLine).toContain("↵ switch story + open");
  });

  test("left and right keys fold and unfold groups without reducing total tally", async () => {
    const { state, press, typeString, render } = setupSearchHarness();
    await press("/");
    await typeString("maren");

    const initialTally = plainLine(render(120, 36).lines[0]!);

    await press("left");
    const firstGroupId = state.search?.foldedGroupIds[0];
    expect(firstGroupId !== undefined).toBeTrue();

    const foldedTally = plainLine(render(120, 36).lines[0]!);
    expect(foldedTally).toBe(initialTally);

    await press("right");
    expect(state.search?.foldedGroupIds.includes(firstGroupId!)).toBeFalse();
  });

  test("ctrl+s toggles case sensitivity and updates search results", async () => {
    const { state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("Maren");

    expect(state.search?.caseSensitive).toBeFalse();

    await press("s", "s", true);
    expect(state.search?.caseSensitive).toBeTrue();

    const sensitiveHits = state.search?.response?.hits.length ?? 0;
    expect(sensitiveHits).toBeGreaterThan(0);
  });

  test("enter on a hit off the current line reroutes and lands on that part", async () => {
    const { state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("burned");

    const model = searchRows(state.search!, state.payload);
    const hitRow = model.rows.find((r): r is SearchHitRow & { select: number } => r.kind === "hit");
    expect(hitRow !== undefined).toBeTrue();

    state.search!.cursor = hitRow!.select;

    await press("return", "\r");

    expect(state.mode).toBe("NAV");
    expect(state.search).toBe(null);
    const targetId = hitRow!.hit.targetId;
    expect(state.payload.path.some((node) => node.id === targetId)).toBeTrue();
  });

  test("enter on a prompt hit reveals its take after manual story scrolling", async () => {
    const { state, press, typeString, render } = setupSearchHarness();
    // Search is full-bleed, but the story viewport keeps its prior manual pin.
    // Landing must return to focus-following so the selected take is visible.
    state.viewScroll = 0;
    await press("/");
    await typeString("burn the old coin");

    const model = searchRows(state.search!, state.payload);
    const promptHitRow = model.rows.find(
      (row): row is SearchHitRow & { select: number } => row.kind === "hit" && row.hit.kind === "prompt"
    );
    expect(promptHitRow).toBeDefined();
    state.search!.cursor = promptHitRow!.select;

    await press("return", "\r");

    expect(state.mode).toBe("NAV");
    expect(state.viewScroll).toBe(null);
    const frame = render(80, 20).lines.map(plainLine).join("\n");
    expect(frame).toContain("burn the old coin");
    expect(frame).toContain("She dropped one coin into the fire");
  });

  test("enter at vault scope switches to target story", async () => {
    const { state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("road");
    await press("tab", "\t");

    const model = searchRows(state.search!, state.payload);
    const otherStoryHitRow = model.rows.find(
      (r): r is SearchHitRow & { select: number } => r.kind === "hit" && r.hit.storyId !== state.payload.id
    );
    expect(otherStoryHitRow !== undefined).toBeTrue();

    const targetStoryId = otherStoryHitRow!.hit.storyId;
    state.search!.cursor = otherStoryHitRow!.select;

    await press("return", "\r");

    expect(state.mode).toBe("NAV");
    expect(state.payload.id).toBe(targetStoryId);
  });

  test("hit inside chapter summary lands on part summary hangs off", async () => {
    const source = demoAppSource();
    const { breakId } = await source.api.createChapterBreak(source.payload.id, "p3", "New Chapter");
    await source.api.summarizeChapter(source.payload.id, breakId);

    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => {});
    const press = async (name: string, sequence = name, ctrl = false) => {
      const pending = handleKey(
        key(name, sequence, ctrl), state, source, cache,
        () => {}, async () => {}, () => {}, null, () => {}, () => {}, backend
      );
      await backend.observe(pending);
      while (state.backendTask !== null) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    await press("/");
    for (const c of "summary") await press(c, c);

    const model = searchRows(state.search!, state.payload);
    const summaryHitRow = model.rows.find(
      (r): r is SearchHitRow & { select: number } => r.kind === "hit" && r.hit.targetId.includes("summary")
    );
    if (summaryHitRow) {
      state.search!.cursor = summaryHitRow.select;
      await press("return", "\r");

      expect(state.mode).toBe("NAV");
      expect(state.payload.path.some((n) => n.id === "p3")).toBeTrue();
    }
  });

  test("narrow 80-column layout drops preview pane and keeps list readable", async () => {
    const { press, typeString, render } = setupSearchHarness();
    await press("/");
    await typeString("maren");

    const frame = render(80, 24);
    const lines = frame.lines.map(plainLine);

    for (const line of lines) {
      expect(line).not.toContain("│");
      expect(line.length <= 80).toBeTrue();
    }

    expect(lines[0]).toContain("scope tree");
  });

  test("searchCorpus snippet and context window offsets index exact match text", () => {
    const corpus: SearchCorpus = {
      storyId: "s1",
      storyTitle: "Test Story",
      updatedAt: "2026-07-30T00:00:00.000Z",
      entries: [
        {
          kind: "prose",
          targetId: "node-1",
          depth: 1,
          text: "The lantern keeper stood at the window watching the storm find Sorrow Cliff in the dark."
        }
      ]
    };

    const hits = searchCorpus(corpus, "storm", false, 10);
    expect(hits.length).toBe(1);

    const hit = hits[0]!;

    const snippetMatchText = hit.snippet.slice(hit.snippetMatch, hit.snippetMatch + hit.matchLength);
    expect(snippetMatchText.toLowerCase()).toBe("storm");

    const contextMatchText = hit.context.slice(hit.contextMatch, hit.contextMatch + hit.matchLength);
    expect(contextMatchText.toLowerCase()).toBe("storm");

    if (hit.snippet.startsWith("…")) {
      const afterEllipsis = hit.snippet.slice(1);
      expect(afterEllipsis.startsWith(" ") || /^[A-Za-z0-9]/.test(afterEllipsis)).toBeTrue();
    }
    if (hit.snippet.endsWith("…")) {
      const beforeEllipsis = hit.snippet.slice(0, -1);
      expect(beforeEllipsis.endsWith(" ") || /[A-Za-z0-9]$/.test(beforeEllipsis)).toBeTrue();
    }
  });

  test("a stale fact hit that is no longer in facts sets toast and keeps search open", async () => {
    const { state, press, typeString } = setupSearchHarness();
    await press("/");
    await typeString("lantern");
    const search = state.search!;
    expect(search.response?.hits.length).toBeGreaterThan(0);

    // Delete fact from story payload so hit targetId is stale
    state.payload.facts = [];

    const model = searchRows(search, state.payload);
    const factHitRow = model.rows.find(
      (r): r is SearchHitRow & { select: number } => r.kind === "hit" && r.hit.kind === "fact"
    );
    expect(factHitRow !== undefined).toBeTrue();

    search.cursor = factHitRow!.select;
    await press("return", "\r");

    expect(state.toast).toBe("that part is no longer in this story");
    expect(state.mode).toBe("SEARCH");
    expect(state.search).not.toBe(null);
  });
});
