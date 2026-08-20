import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KeyEvent } from "@opentui/core";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import { MAX_GENERATION_RECORD_TEXT_CHARS, type ResolvedGenerationRecord } from "../../shared/generation-record.js";
import { textHash } from "../src/api.js";
import { handleKey, initialState } from "../src/app.js";
import type { AppSource } from "../src/app.js";
import { generationRecordPipelineRows } from "../src/generation-record-pipeline.js";
import { resolveGenerationRecordKey } from "../src/generation-record-actions.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import type { GenerationRecordListState, GenerationRecordViewerState } from "../src/state.js";
import { createWorkerStoryApi, type WorkerStoryApi } from "../src/worker-api.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

/** The currently loaded resolved record, or null while idle, loading, or
 *  errored — the same narrowing `screens/generation-record-viewer.ts` and
 *  `generation-record-actions.ts` do at each of their own call sites. */
function resolvedDetail(record: GenerationRecordViewerState | null | undefined): ResolvedGenerationRecord | null {
  return record != null && record.detail.status === "ready" ? record.detail.detail : null;
}

/** The loaded summary list, or null while loading, errored, or absent —
 *  the same narrowing `resolvedDetail` does for the detail stage. */
function readySummaries(
  record: GenerationRecordViewerState | null | undefined
): Extract<GenerationRecordListState, { status: "ready" }> | null {
  return record != null && record.list.status === "ready" ? record.list : null;
}

/**
 * The Generation Record Viewer, driven end-to-end through a real dry-run
 * generation and the embedded worker backend (the same `StoryApi` the
 * interactive TUI talks to) — mirrors `token-probabilities-e2e.test.ts`.
 * The capture, storage, and both read routes (`getGenerationRecords`,
 * `getGenerationRecord`) all run for real here, so this proves the whole
 * pipeline from `server/generation-record-capture.ts` through the client
 * decoder to the rendered frame, not one layer standing in for another.
 */

function key(name: string, shift = false): KeyEvent {
  return { name, sequence: name, shift, ctrl: false, meta: false } as KeyEvent;
}

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function embeddedBackend(): Promise<WorkerStoryApi> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-e2e-"));
  const previousData = process.env.AI_1667_DATA;
  process.env.AI_1667_DATA = dataDir;
  const backend = await createWorkerStoryApi();
  cleanup = async () => {
    await backend.dispose();
    if (previousData === undefined) delete process.env.AI_1667_DATA;
    else process.env.AI_1667_DATA = previousData;
    await rm(dataDir, { recursive: true, force: true });
  };
  return backend;
}

function appSource(
  api: WorkerStoryApi["api"],
  settingsView: Awaited<ReturnType<WorkerStoryApi["api"]["getSettings"]>>
): AppSource {
  return {
    payload: {
      id: "", title: "", createdAt: "", updatedAt: "", path: [], nodes: [],
      tags: [], facts: [], chapterBreaks: [], recentNodeIds: [], activeRootId: null
    } as unknown as AppSource["payload"],
    api,
    demo: false,
    stories: [],
    settingsView,
    settings: settingsView.effective,
    storyFolder: "",
    exportDirectory: process.cwd(),
    connection: null,
    config: {
      schemaVersion: 1,
      theme: "lantern",
      factsRail: "auto",
      composeFocus: "off",
      wordWrap: "on",
      composeMaxHeight: null,
      quota: { date: "", words: 0 },
      updates: { mode: "notify", channel: "stable", skippedVersion: null },
      lastRunVersion: null,
      settingsViewMode: "simple"
    },
    readingPositions: {}
  };
}

describe("resolveGenerationRecordKey", () => {
  test("maps the accepted design's exact key vocabulary", () => {
    expect(resolveGenerationRecordKey(key("left")).action).toBe("take-previous");
    expect(resolveGenerationRecordKey(key("right")).action).toBe("take-next");
    expect(resolveGenerationRecordKey(key("down")).action).toBe("focus-next");
    expect(resolveGenerationRecordKey(key("up")).action).toBe("focus-previous");
    expect(resolveGenerationRecordKey(key("down", true)).action).toBe("scroll-line-down");
    expect(resolveGenerationRecordKey(key("up", true)).action).toBe("scroll-line-up");
    expect(resolveGenerationRecordKey(key("pagedown")).action).toBe("scroll-down");
    expect(resolveGenerationRecordKey(key("pageup")).action).toBe("scroll-up");
    expect(resolveGenerationRecordKey(key("g")).action).toBe("top");
    expect(resolveGenerationRecordKey(key("g", true)).action).toBe("leaf");
  });
});

describe("generation record viewer: end-to-end dry-run generation", () => {
  test("h opens the newest record for the focused take from NAV, moving neither focus nor the story", async () => {
    const backend = await embeddedBackend();
    const api = backend.api;
    const created = await api.createStory("Generation record fixture");
    const first = await api.continueStory(
      created.id, "Continue.", "gen-record-e2e-1", { parentId: null }, () => {}, new AbortController().signal
    );
    expect(first).not.toBe(null);
    const leafId = first!.payload.path.at(-1)!.id;
    const beforeText = first!.payload.path.at(-1)!.text;
    const appended = await api.continueStory(
      created.id, "", "gen-record-e2e-1-append",
      { appendTo: leafId, expectedTextHash: await textHash(beforeText) },
      () => {}, new AbortController().signal
    );
    expect(appended).not.toBe(null);
    const payload = appended!.payload;
    expect(payload.nodes.find((node) => node.id === leafId)?.generationRecordCount).toBe(2);
    // The path carries the same take in full, but its Generation Record
    // history still travels only as a count — the ordered id list stays off
    // the wire, fetched on demand instead (server/stories.ts's
    // loadGenerationRecordSummaries).
    const pathLeaf = payload.path.find((node) => node.id === leafId);
    expect(pathLeaf?.generationRecordCount).toBe(2);
    expect((pathLeaf as { generationRecordIds?: unknown } | undefined)?.generationRecordIds).toBe(undefined);

    const settingsView = await api.getSettings();
    const source = appSource(api, settingsView);
    source.payload = payload;
    const state = initialState(source, false);
    state.focusIndex = rowIndexForNode(createStoryViewModel(payload), leafId);
    const focusBefore = state.focusIndex;
    const payloadBefore = state.payload;
    const cache = createWrapCache<ProseStyle>();

    await handleKey(
      key("h"), state, source, cache, () => {}, async () => {}, () => {},
      { updateChecks: INERT_UPDATE_CHECK_LIFECYCLE }
    );

    expect(state.mode).toBe("RECORD");
    expect(state.record).not.toBe(null);
    expect(state.record?.nodeId).toBe(leafId);
    expect(state.record?.returnMode).toBe("NAV");
    expect(readySummaries(state.record)?.summaries.length).toBe(2);
    // Newest first: the append is index 1, oldest-first (server/stories.ts's
    // `loadGenerationRecordSummaries`).
    expect(state.record?.eventIndex).toBe(1);
    expect(resolvedDetail(state.record)?.kind).toBe("append");
    // h never moves NAV's own focus or mutates the story it is reading.
    expect(state.focusIndex).toBe(focusBefore);
    expect(state.payload).toBe(payloadBefore);

    const frame = frameText(renderStoryScreen(state, { width: 120, height: 40, wrapCache: cache }).lines);
    expect(frame).toContain("generation record");
    expect(frame).toContain("event 2/2");
    expect(frame).toContain("append");
    expect(frame).toContain("dry-run");

    await handleKey(
      key("escape"), state, source, cache, () => {}, async () => {}, () => {},
      { updateChecks: INERT_UPDATE_CHECK_LIFECYCLE }
    );
    expect(state.mode).toBe("NAV");
    expect(state.record).toBe(null);
    expect(state.focusIndex).toBe(focusBefore);
  }, 30_000);

  test("left/right walk older/newer events and reload each event's own detail", async () => {
    const backend = await embeddedBackend();
    const api = backend.api;
    const created = await api.createStory("Event navigation fixture");
    const first = await api.continueStory(
      created.id, "Continue.", "gen-record-e2e-2", { parentId: null }, () => {}, new AbortController().signal
    );
    expect(first).not.toBe(null);
    const leafId = first!.payload.path.at(-1)!.id;
    const beforeText = first!.payload.path.at(-1)!.text;
    const appended = await api.continueStory(
      created.id, "", "gen-record-e2e-2-append",
      { appendTo: leafId, expectedTextHash: await textHash(beforeText) },
      () => {}, new AbortController().signal
    );
    expect(appended).not.toBe(null);

    const settingsView = await api.getSettings();
    const source = appSource(api, settingsView);
    source.payload = appended!.payload;
    const state = initialState(source, false);
    state.focusIndex = rowIndexForNode(createStoryViewModel(source.payload), leafId);
    const cache = createWrapCache<ProseStyle>();
    const press = (name: string, shift = false) =>
      handleKey(
        key(name, shift), state, source, cache, () => {}, async () => {}, () => {},
        { updateChecks: INERT_UPDATE_CHECK_LIFECYCLE }
      );

    await press("h");
    expect(state.record?.eventIndex).toBe(1);
    expect(resolvedDetail(state.record)?.kind).toBe("append");

    await press("left");
    expect(state.record?.eventIndex).toBe(0);
    expect(resolvedDetail(state.record)?.kind).toBe("continue");
    // A boundary press stays put rather than wrapping or throwing.
    await press("left");
    expect(state.record?.eventIndex).toBe(0);

    await press("right");
    expect(state.record?.eventIndex).toBe(1);
    expect(resolvedDetail(state.record)?.kind).toBe("append");
    // Cached: reselecting the already-loaded event does not clear detail
    // while a fresh fetch would be in flight.
    await press("left");
    expect(resolvedDetail(state.record)?.kind).toBe("continue");

    // g/G move the entry cursor to the first and last pipeline row of the
    // *current* event — the request viewer's own meaning for the same keys —
    // never between events, which is left/right's job.
    const entries = generationRecordPipelineRows(resolvedDetail(state.record)!);
    expect(state.record?.entryIndex).toBe(0);
    await press("g", true);
    expect(state.record?.entryIndex).toBe(Math.max(0, entries.length - 1));
    await press("g");
    expect(state.record?.entryIndex).toBe(0);
  }, 30_000);

  test("h opens an inactive MAP take without activating it, and escape returns to MAP", async () => {
    const backend = await embeddedBackend();
    const api = backend.api;
    const created = await api.createStory("Map fixture");
    const first = await api.continueStory(
      created.id, "Continue one way.", "gen-record-map-a", { parentId: null }, () => {}, new AbortController().signal
    );
    expect(first).not.toBe(null);
    const inactiveId = first!.payload.path.at(-1)!.id;
    // A second root-level continuation supersedes the first as the active
    // reading line, leaving it as an inactive sibling MAP can still reach.
    const second = await api.continueStory(
      created.id, "Continue another way.", "gen-record-map-b", { parentId: null }, () => {}, new AbortController().signal
    );
    expect(second).not.toBe(null);
    const activeId = second!.payload.path.at(-1)!.id;
    expect(activeId).not.toBe(inactiveId);
    expect(second!.payload.path.some((node) => node.id === inactiveId)).toBe(false);
    expect(second!.payload.nodes.some((node) => node.id === inactiveId)).toBe(true);

    const settingsView = await api.getSettings();
    const source = appSource(api, settingsView);
    source.payload = second!.payload;
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const press = (name: string, shift = false) =>
      handleKey(
        key(name, shift), state, source, cache, () => {}, async () => {}, () => {},
        { updateChecks: INERT_UPDATE_CHECK_LIFECYCLE }
      );

    await press("m");
    expect(state.mode).toBe("MAP");
    expect(state.map).not.toBe(null);
    // The design forbids h from moving MAP's own focus; point it at the
    // inactive sibling directly rather than re-deriving path-cursor motion
    // that belongs to map-actions.ts's own tests.
    state.map!.pathCursorId = inactiveId;
    const payloadBefore = state.payload;

    await press("h");
    expect(state.mode).toBe("RECORD");
    expect(state.record?.nodeId).toBe(inactiveId);
    expect(state.record?.returnMode).toBe("MAP");
    // Viewing an inactive take's history must not activate it.
    expect(state.payload).toBe(payloadBefore);
    expect(state.payload.path.at(-1)?.id).toBe(activeId);

    await press("escape");
    expect(state.mode).toBe("MAP");
    expect(state.record).toBe(null);
    expect(state.map?.pathCursorId).toBe(inactiveId);
  }, 30_000);

  test("an over-limit prompt's unsupported record shows its reason and safe metadata, not a crash", async () => {
    const backend = await embeddedBackend();
    const api = backend.api;
    const created = await api.createStory("Unsupported fixture");
    const result = await api.continueStory(
      created.id,
      "x".repeat(MAX_GENERATION_RECORD_TEXT_CHARS + 1),
      "gen-record-unsupported",
      { parentId: null },
      () => {},
      new AbortController().signal
    );
    expect(result).not.toBe(null);
    const leafId = result!.payload.path.at(-1)!.id;

    const settingsView = await api.getSettings();
    const source = appSource(api, settingsView);
    source.payload = result!.payload;
    const state = initialState(source, false);
    state.focusIndex = rowIndexForNode(createStoryViewModel(source.payload), leafId);
    const cache = createWrapCache<ProseStyle>();

    await handleKey(
      key("h"), state, source, cache, () => {}, async () => {}, () => {},
      { updateChecks: INERT_UPDATE_CHECK_LIFECYCLE }
    );
    expect(resolvedDetail(state.record)?.kind).toBe("unsupported");
    expect(resolvedDetail(state.record)?.prompt.entries).toEqual([]);

    const frame = frameText(renderStoryScreen(state, { width: 120, height: 40, wrapCache: cache }).lines);
    expect(frame).toContain("unsupported");
    expect(frame).toMatch(/exceeds the 65536-character limit/u);
    expect(frame).toContain("dry-run");
  }, 30_000);

  test("preserves the ordered pipeline and the Author's Note split, resolved to exact historical prose", async () => {
    const backend = await embeddedBackend();
    const api = backend.api;
    const created = await api.createStory("Author's note fixture");
    const root = await api.createNode(created.id, {
      parentId: null,
      text: "The lighthouse stood alone.",
      instruction: "Chapter one begins."
    });
    const rootId = root.path.at(-1)!.id;
    const withChild = await api.createNode(created.id, {
      parentId: rootId,
      text: "Rain lashed the windows.",
      instruction: "Then the storm came."
    });
    const childId = withChild.path.at(-1)!.id;
    await api.setAuthorsNote(created.id, "The lighthouse keeper is secretly the storm's cause.", 1);

    const continued = await api.continueStory(
      created.id, "Continue.", "gen-record-note", { parentId: childId }, () => {}, new AbortController().signal
    );
    expect(continued).not.toBe(null);
    const generatedId = continued!.payload.path.at(-1)!.id;

    const settingsView = await api.getSettings();
    const source = appSource(api, settingsView);
    source.payload = continued!.payload;
    const state = initialState(source, false);
    state.focusIndex = rowIndexForNode(createStoryViewModel(source.payload), generatedId);
    const cache = createWrapCache<ProseStyle>();

    await handleKey(
      key("h"), state, source, cache, () => {}, async () => {}, () => {},
      { updateChecks: INERT_UPDATE_CHECK_LIFECYCLE }
    );
    const detail = resolvedDetail(state.record);
    expect(detail).not.toBe(null);
    const entries = detail!.prompt.entries;
    const kinds = entries.map((entry) => entry.kind);
    const noteIndex = kinds.indexOf("authors-note");
    const requestIndex = kinds.indexOf("request");
    expect(noteIndex).not.toBe(-1);
    expect(requestIndex).not.toBe(-1);
    const sourceIndexes = kinds.reduce<number[]>((found, kind, index) => (kind === "source" ? [...found, index] : found), []);
    expect(sourceIndexes.length).toBe(2);
    const beforeNote = entries[sourceIndexes[0]!];
    const afterNote = entries[sourceIndexes[1]!];
    expect(sourceIndexes[0]).toBeLessThan(noteIndex);
    expect(noteIndex).toBeLessThan(sourceIndexes[1]!);
    expect(sourceIndexes[1]).toBeLessThan(requestIndex);
    if (beforeNote === undefined || beforeNote.source !== "revisions") throw new Error("expected a resolved source entry before the note");
    if (afterNote === undefined || afterNote.source !== "revisions") throw new Error("expected a resolved source entry after the note");
    expect(beforeNote.parts[0]?.nodeId).toBe(rootId);
    expect(beforeNote.parts[0]?.text).toBe("The lighthouse stood alone.");
    expect(beforeNote.parts[0]?.category).toBe("recent");
    expect(afterNote.parts[0]?.nodeId).toBe(childId);
    expect(afterNote.parts[0]?.text).toBe("Rain lashed the windows.");

    // A generous height sidesteps the body's own scroll window so every row
    // paints in one frame; scrolling itself is exercised by the key-mapping
    // and reducer-level tests above.
    const frame = frameText(renderStoryScreen(state, { width: 120, height: 400, wrapCache: cache }).lines);
    expect(frame).toContain("The lighthouse stood alone.");
    expect(frame).toContain("Rain lashed the windows.");
    expect(frame).toContain("The lighthouse keeper is secretly the storm's cause.");
  }, 30_000);

  test("needs no model credentials and never requests a live token count", async () => {
    const backend = await embeddedBackend();
    const api = backend.api;
    const created = await api.createStory("No credentials fixture");
    const result = await api.continueStory(
      created.id, "Continue.", "gen-record-no-creds", { parentId: null }, () => {}, new AbortController().signal
    );
    expect(result).not.toBe(null);
    const leafId = result!.payload.path.at(-1)!.id;

    const settingsView = await api.getSettings();
    // The dry-run route this fixture already uses carries no api key, base
    // URL, or header of any kind (server/providers.ts) — proof by
    // construction rather than by inspecting a credential that never exists.
    expect(settingsView.effective.apiKeyEnv).toBe(null);

    const source = appSource(api, settingsView);
    source.payload = result!.payload;
    const state = initialState(source, false);
    state.focusIndex = rowIndexForNode(createStoryViewModel(source.payload), leafId);
    const cache = createWrapCache<ProseStyle>();
    let tokenCountCalls = 0;
    let tokenProbabilityCalls = 0;
    const countPromptTokens = api.countPromptTokens.bind(api);
    const getTokenProbabilities = api.getTokenProbabilities.bind(api);
    api.countPromptTokens = async (...args) => { tokenCountCalls += 1; return await countPromptTokens(...args); };
    api.getTokenProbabilities = async (...args) => { tokenProbabilityCalls += 1; return await getTokenProbabilities(...args); };

    const press = (name: string, shift = false) =>
      handleKey(
        key(name, shift), state, source, cache, () => {}, async () => {}, () => {},
        { updateChecks: INERT_UPDATE_CHECK_LIFECYCLE }
      );
    await press("h");
    await press("down");
    await press("up");
    await press("escape");

    expect(tokenCountCalls).toBe(0);
    expect(tokenProbabilityCalls).toBe(0);
  }, 30_000);

  test("renders a populated record at width 80 and 120 without losing critical identity", async () => {
    const backend = await embeddedBackend();
    const api = backend.api;
    const created = await api.createStory("Narrow width fixture");
    const result = await api.continueStory(
      created.id, "Continue.", "gen-record-width", { parentId: null }, () => {}, new AbortController().signal
    );
    expect(result).not.toBe(null);
    const leafId = result!.payload.path.at(-1)!.id;

    const settingsView = await api.getSettings();
    const source = appSource(api, settingsView);
    source.payload = result!.payload;
    const state = initialState(source, false);
    state.focusIndex = rowIndexForNode(createStoryViewModel(source.payload), leafId);
    const cache = createWrapCache<ProseStyle>();
    await handleKey(
      key("h"), state, source, cache, () => {}, async () => {}, () => {},
      { updateChecks: INERT_UPDATE_CHECK_LIFECYCLE }
    );
    expect(resolvedDetail(state.record)).not.toBe(null);

    for (const width of [80, 120]) {
      const composition = renderStoryScreen(state, { width, height: 40, wrapCache: cache });
      expect(composition.lines).toHaveLength(40);
      const frame = frameText(composition.lines);
      expect(frame).toContain("generation record");
      expect(frame).toContain("event 1/1");
      expect(frame).toContain("dry-run");
    }
  }, 30_000);
});
