import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import type { StoryPayload, StorySummary } from "../../shared/types.js";
import { ActionRuntime, beginInteraction } from "../src/action-runtime.js";
import { ApiHttpError } from "../src/api.js";
import { handleKey, initialState } from "../src/app.js";
import { createComposer, setComposerText } from "../src/composer-model.js";
import {
  connectionSucceeded,
  createConnectionMonitor,
  type ConnectionMonitor,
  type ConnectionState
} from "../src/connection.js";
import { createDemoController, demoAppSource } from "../src/demo.js";
import { openPartEditor } from "../src/editor-action.js";
import { openMap } from "../src/map-actions.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { startRecoveryOrchestration } from "../src/recovery-orchestration.js";
import { RecoveryWarningFeed } from "../src/recovery-warning-feed.js";
import { WorkerApiError, type WorkerRecoveryWarning } from "../src/worker-api.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { createStoryViewModel, rowIndexForNode, rowPart } from "../src/model.js";
import { factRows } from "../src/facts-model.js";
import { applyOpeningFocus } from "../src/reading-position.js";
import { adoptReconciliationSnapshot, adoptSameStoryPayload } from "../src/story-adoption.js";
import { createPrunePlan, createUnusedTakesPrunePlan } from "../src/prune-model.js";
import { nextRequestContext } from "../src/request-context.js";
import { initialSettingsOverlay, SETTINGS_ROW_IDS } from "../src/settings-overlay-model.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function key(name: string, sequence = name): KeyEvent {
  return { name, sequence, shift: false, ctrl: false, meta: false } as KeyEvent;
}

function ctrlP(): KeyEvent {
  return { ...key("p", "\u0010"), ctrl: true } as KeyEvent;
}

async function typeQuery(
  press: (event: KeyEvent) => Promise<void>,
  query: string
): Promise<void> {
  for (const character of query) await press(key(character));
}

describe("backend recovery orchestration", () => {
  test("same-story warnings remain visible and acknowledge after local input", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    source.backendRecovery = feed;
    const entered = deferred<void>();
    const reload = deferred<StoryPayload>();
    let reloads = 0;
    source.api.loadStory = async () => {
      reloads += 1;
      entered.resolve();
      return reload.promise;
    };
    const warning: WorkerRecoveryWarning = {
      mutationId: "m1-local-input",
      method: "renameStory",
      storyId: source.payload.id,
      resolution: "archived",
      error: new WorkerApiError(createFailureEnvelope({
        code: "mutation_outcome_unknown",
        message: "Reload state.",
        status: 409
      }))
    };
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const settled = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null
        && state.toast === "interrupted change checked") {
        settled.resolve();
      }
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache,
      repaint
    });

    expect(feed.publish([warning])).toBeTrue();
    await entered.promise;
    beginInteraction(state);
    reload.resolve(source.payload);
    await settled.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.toast).toBe("interrupted change checked");
    expect(reloads).toBe(1);
    expect(feed.publish([warning])).toBeFalse();
    stop();
  });

  test("same-story recovery closes invalid newer targets but preserves a draft and focus", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    const entered = deferred<void>();
    const reload = deferred<StoryPayload>();
    const deletedLeaf = createDemoController().deleteNode("p13", 1);
    const recoveredPayload = {
      ...deletedLeaf,
      title: "authoritative title",
      chapterBreaks: deletedLeaf.chapterBreaks.filter(({ id }) => id !== "chapter-break-1"),
      facts: deletedLeaf.facts.filter(({ id }) => id !== "fact-1")
    };
    source.backendRecovery = feed;
    source.api.loadStory = async () => { entered.resolve(); return reload.promise; };
    const state = initialState(source, false);
    const focusId = "p12";
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), focusId);
    state.mode = "COMPOSE";
    state.composer = createComposer("keep this draft");
    state.viewScroll = 7;
    state.lastViewportStart = 7;
    const cache = createWrapCache<ProseStyle>();
    const settled = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === recoveredPayload) settled.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache,
      repaint
    });

    feed.publish([], true);
    await entered.promise;
    state.undo = [{ kind: "create-break", breakId: "chapter-break-1" }];
    state.prune = {
      kind: "subtree", nodeId: "p13", part: 13, take: 1,
      takeCount: 1, parts: 1, lines: 1, tags: []
    };
    state.tag = {
      nodeId: "p13", name: "newer prompt", statusIndex: 0,
      choosingStatus: false, existing: false, returnMode: "NAV"
    };
    state.chapterDeleteArmedId = "chapter-break-1";
    state.chapters = {
      cursor: 1,
      rename: { breakId: "chapter-break-1", composer: createComposer("newer title") }, deleteArmedId: "chapter-break-1"
    };
    state.facts = {
      cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: "fact-1"
    };

    reload.resolve(recoveredPayload);
    await settled.promise;

    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("keep this draft");
    expect(rowPart(createStoryViewModel(state.payload), state.focusIndex)?.id).toBe(focusId);
    expect(state.viewScroll).toBe(7);
    expect(state.lastViewportStart).toBe(7);
    expect(state.undo).toEqual([]);
    expect(state.prune).toBe(null);
    expect(state.tag).toBe(null);
    expect(state.chapterDeleteArmedId).toBe(null);
    expect(state.chapters?.rename).toBe(null);
    expect(state.chapters?.deleteArmedId).toBe(null);
    expect(state.facts?.deleteArmedId).toBe(null);
    stop();
  });

  test("same-story recovery preserves target-valid prompts opened while loading", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    const entered = deferred<void>();
    const reload = deferred<StoryPayload>();
    const prunedLeaf = createDemoController().deleteNode("p13", 1);
    const recoveredPayload = {
      ...prunedLeaf,
      title: "authoritative title",
      tags: [...prunedLeaf.tags, {
        ...source.payload.tags[0]!,
        nodeId: "p12-t4",
        name: "remote tag"
      }]
    };
    source.backendRecovery = feed;
    source.api.loadStory = async () => { entered.resolve(); return reload.promise; };
    const state = initialState(source, false);
    const settled = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === recoveredPayload) settled.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache: createWrapCache<ProseStyle>(),
      repaint
    });

    feed.publish([], true);
    await entered.promise;
    const prune = createPrunePlan(state.payload, "p12")!;
    const tag = {
      nodeId: "p12-t4", name: "typed while loading", statusIndex: 2,
      choosingStatus: true, existing: false, returnMode: "NAV" as const
    };
    const rename = { breakId: "chapter-break-1", composer: createComposer("typed chapter title") };
    state.undo = [{ kind: "create-break", breakId: "chapter-break-1" }];
    state.prune = prune;
    state.tag = tag;
    state.mode = "TAG";
    state.chapters = { cursor: 1, rename, deleteArmedId: "chapter-break-2" };
    state.facts = {
      cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: "fact-1"
    };

    reload.resolve(recoveredPayload);
    await settled.promise;

    expect(state.undo).toEqual([]);
    expect(state.prune).toBe(prune);
    expect(state.prune).toMatchObject({ kind: "subtree", nodeId: "p12", parts: 1 });
    expect(state.tag).toBe(tag);
    expect(state.tag).toMatchObject({
      name: "typed while loading", choosingStatus: true, existing: true
    });
    expect(state.mode).toBe("TAG");
    expect(state.chapters?.rename).toBe(rename);
    expect(state.chapters?.deleteArmedId).toBe("chapter-break-2");
    expect(state.facts?.deleteArmedId).toBe("fact-1");
    stop();
  });

  test("same-story recovery reconciles a semantic panel and keeps its valid confirmation", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    const selectedId = source.payload.facts[1]!.id;
    const recoveredPayload = { ...source.payload, facts: [...source.payload.facts].reverse() };
    source.backendRecovery = feed;
    source.api.loadStory = async () => recoveredPayload;
    const state = initialState(source, false);
    const facts = {
      cursor: 1, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: selectedId
    };
    state.mode = "FACTS";
    state.facts = facts;
    const settled = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === recoveredPayload) settled.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache: createWrapCache<ProseStyle>(),
      repaint
    });

    feed.publish([], true);
    await settled.promise;

    expect(state.mode).toBe("FACTS");
    expect(state.facts).toBe(facts);
    expect(factRows(state.payload.facts, null, "")[state.facts!.cursor]?.id).toBe(selectedId);
    expect(state.facts!.deleteArmedId).toBe(selectedId);
    stop();
  });

  test("reconciliation refreshes whole-story prune safety metadata and closes an empty preview", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const preview = createUnusedTakesPrunePlan(state.payload)!;
    const reducedPayload = createDemoController().deleteNode("p12-t1", 1);
    state.prune = preview;

    adoptReconciliationSnapshot(state, reducedPayload, createWrapCache<ProseStyle>());

    expect(state.prune).toBe(preview);
    expect(state.prune).toMatchObject({ kind: "unused-takes", takes: 4, parts: 4 });

    const emptyState = initialState(demoAppSource(), false);
    emptyState.prune = createUnusedTakesPrunePlan(emptyState.payload);
    const activeIds = new Set(emptyState.payload.path.map(({ id }) => id));
    const activeLineOnly = {
      ...emptyState.payload,
      nodes: emptyState.payload.nodes.filter(({ id }) => activeIds.has(id)),
      tags: emptyState.payload.tags.filter(({ nodeId }) => activeIds.has(nodeId))
    };
    adoptReconciliationSnapshot(emptyState, activeLineOnly, createWrapCache<ProseStyle>());
    expect(emptyState.prune).toBe(null);
  });

  test("reconciliation drops a stale Generation Profile import prompt", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "SETTINGS";
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    state.settings.profileTransfer = {
      phase: "file", path: "/tmp/stale.preset", candidates: [], error: null
    };

    adoptReconciliationSnapshot(
      state,
      { ...state.payload, id: "recovered-story" },
      createWrapCache<ProseStyle>()
    );

    expect(state.settings).toBe(null);
    expect(state.mode).toBe("NAV");
  });

  test("direct chapter deletion remains armed only on the surviving focused divider", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const view = createStoryViewModel(state.payload);
    state.focusIndex = view.rows.findIndex((row) =>
      row.kind === "chapter-divider" && row.break.id === "chapter-break-1");
    state.chapterDeleteArmedId = "chapter-break-1";

    adoptReconciliationSnapshot(state, { ...state.payload, title: "refreshed" }, createWrapCache<ProseStyle>());
    expect(state.chapterDeleteArmedId).toBe("chapter-break-1");

    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    adoptReconciliationSnapshot(state, { ...state.payload, title: "refreshed again" }, createWrapCache<ProseStyle>());
    expect(state.chapterDeleteArmedId).toBe(null);
  });

  test("reconciliation repairs removed map and action targets without leaving a dead mode", () => {
    const recoveredPayload = createDemoController().deleteNode("p13", 1);

    const tagState = initialState(demoAppSource(), false);
    tagState.mode = "TAG";
    tagState.map = {
      view: "path", pathCursorId: "p13", pathShowAllTakes: true, treeCursorId: "p13", rowIds: [],
      showSketches: false, openedColdFolds: new Set(), massSort: "size"
    };
    tagState.tag = {
      nodeId: "p13", name: "stale", statusIndex: 0,
      choosingStatus: false, existing: false, returnMode: "MAP"
    };
    adoptReconciliationSnapshot(tagState, recoveredPayload, createWrapCache<ProseStyle>());
    expect(tagState.tag).toBe(null);
    expect(tagState.mode).toBe("MAP");
    expect(tagState.map?.pathCursorId).toBe(recoveredPayload.path.at(-1)?.id);

    const actionsState = initialState(demoAppSource(), false);
    actionsState.mode = "ACTIONS";
    actionsState.actions = {
      cursor: 0,
      partId: "p13",
      selectionText: null
    };
    adoptReconciliationSnapshot(actionsState, recoveredPayload, createWrapCache<ProseStyle>());
    expect(actionsState.actions).toBe(null);
    expect(actionsState.mode).toBe("NAV");
  });

  test("same-story reconciliation retargets a palette away from removed owners", async () => {
    const recoveredPayload = createDemoController().deleteNode("p13", 1);
    const pressEscape = (
      state: ReturnType<typeof initialState>,
      source: ReturnType<typeof demoAppSource>,
      cache: ReturnType<typeof createWrapCache<ProseStyle>>
    ) => handleKey(
      key("escape", "\u001b"),
      state,
      source,
      cache,
      () => undefined,
      async () => undefined,
      () => undefined
    );

    const actionsSource = demoAppSource();
    const actionsState = initialState(actionsSource, false);
    actionsState.actions = { cursor: 0, partId: "p13", selectionText: null };
    actionsState.mode = "COMMANDS";
    actionsState.commands = {
      query: "", cursor: 0, selectedId: null, view: "commands", returnMode: "ACTIONS"
    };
    const actionsCache = createWrapCache<ProseStyle>();
    adoptSameStoryPayload(actionsState, recoveredPayload, actionsCache);
    expect(actionsState.actions).toBe(null);
    expect(actionsState.mode).toBe("COMMANDS");
    expect(actionsState.commands?.returnMode).toBe("NAV");
    await pressEscape(actionsState, actionsSource, actionsCache);
    expect(actionsState.mode).toBe("NAV");

    const tagSource = demoAppSource();
    const tagState = initialState(tagSource, false);
    openMap(tagState);
    tagState.tag = {
      nodeId: "p13", name: "stale", statusIndex: 0,
      choosingStatus: false, existing: false, returnMode: "MAP"
    };
    tagState.mode = "COMMANDS";
    tagState.commands = {
      query: "", cursor: 0, selectedId: null, view: "commands", returnMode: "TAG"
    };
    const tagCache = createWrapCache<ProseStyle>();
    adoptSameStoryPayload(tagState, recoveredPayload, tagCache);
    expect(tagState.tag).toBe(null);
    expect(tagState.mode).toBe("COMMANDS");
    expect(tagState.commands?.returnMode).toBe("MAP");
    await pressEscape(tagState, tagSource, tagCache);
    expect(tagState.mode).toBe("MAP");
    expect(tagState.map).not.toBe(null);

    const editorSource = demoAppSource();
    const editorState = initialState(editorSource, false);
    editorState.focusIndex = rowIndexForNode(createStoryViewModel(editorState.payload), "p13");
    openPartEditor(editorState, false);
    editorState.editor!.returnMode = "FACTS";
    editorState.facts = {
      cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: null
    };
    editorState.mode = "COMMANDS";
    editorState.commands = {
      query: "", cursor: 0, selectedId: null, view: "commands", returnMode: "EDITOR"
    };
    const editorCache = createWrapCache<ProseStyle>();
    adoptSameStoryPayload(editorState, recoveredPayload, editorCache);
    expect(editorState.editor).toBe(null);
    expect(editorState.mode).toBe("COMMANDS");
    expect(editorState.commands?.returnMode).toBe("FACTS");
    await pressEscape(editorState, editorSource, editorCache);
    expect(editorState.mode).toBe("FACTS");

    const mapSource = demoAppSource();
    const mapState = initialState(mapSource, false);
    openMap(mapState);
    mapState.mode = "COMMANDS";
    mapState.commands = {
      query: "", cursor: 0, selectedId: null, view: "commands", returnMode: "MAP"
    };
    const emptyPayload = {
      ...mapSource.payload,
      nodes: [], path: [], activeRootId: null, tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
    };
    const mapCache = createWrapCache<ProseStyle>();
    adoptSameStoryPayload(mapState, emptyPayload, mapCache);
    expect(mapState.map).toBe(null);
    expect(mapState.mode).toBe("COMMANDS");
    expect(mapState.commands?.returnMode).toBe("NAV");
    await pressEscape(mapState, mapSource, mapCache);
    expect(mapState.mode).toBe("NAV");
  });
});


function onlineMonitor(
  api: ReturnType<typeof demoAppSource>["api"],
  retryNow: () => Promise<boolean>
): ConnectionMonitor {
  return {
    api,
    state: connectionSucceeded,
    retryNow,
    subscribe: () => () => undefined,
    dispose: () => undefined
  };
}

function transitioningMonitor(api: ReturnType<typeof demoAppSource>["api"]): ConnectionMonitor {
  let current: ConnectionState = {
    down: true,
    attempt: 1,
    nextRetryAt: null,
    error: "offline"
  };
  let listener: ((state: ConnectionState) => void) | null = null;
  return {
    api,
    state: () => ({ ...current }),
    async retryNow() {
      current = connectionSucceeded();
      listener?.(current);
      return true;
    },
    subscribe(next) {
      listener = next;
      return () => { listener = null; };
    },
    dispose: () => undefined
  };
}

function controlledMonitor(
  api: ReturnType<typeof demoAppSource>["api"],
  initial: ConnectionState
): { monitor: ConnectionMonitor; publish(connection: ConnectionState): void } {
  let current = initial;
  let listener: ((state: ConnectionState) => void) | null = null;
  return {
    monitor: {
      api,
      state: () => ({ ...current }),
      retryNow: async () => !current.down,
      subscribe(next) {
        listener = next;
        return () => { listener = null; };
      },
      dispose: () => undefined
    },
    publish(connection) {
      current = connection;
      listener?.(connection);
    }
  };
}


/** Fire once per adoption commit. reconcileWrapCache reads partIds() exactly
 * once for a same-story snapshot and calls one full invalidate() for a
 * different story, so either signal marks one committed reconciliation. */
function reconcileSpyCache(onReconcile: () => void): ReturnType<typeof createWrapCache<ProseStyle>> {
  const cache = createWrapCache<ProseStyle>();
  return {
    wrap: (partId, width, text, runs, identity) => cache.wrap(partId, width, text, runs, identity),
    lineCount: (partId, width, text, identity) => cache.lineCount(partId, width, text, identity),
    isWarm: (partId, width, text, runs, identity) => cache.isWarm(partId, width, text, runs, identity),
    appendCandidate: (partId, width, appendStart) => cache.appendCandidate(partId, width, appendStart),
    prime: (partId, width, text, runs, lines, identity) => cache.prime(partId, width, text, runs, lines, identity),
    invalidate: (partId) => {
      if (partId === undefined) onReconcile();
      cache.invalidate(partId);
    },
    rebind: (partId, source, textLength) => cache.rebind(partId, source, textLength),
    partIds: () => {
      onReconcile();
      return cache.partIds();
    },
    get epoch() { return cache.epoch; },
    get revision() { return cache.revision; },
    get hits() { return cache.hits; },
    get misses() { return cache.misses; }
  };
}
