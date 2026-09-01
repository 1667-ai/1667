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
import { handleOverlayAction } from "../src/overlay-actions.js";
import { startRecoveryOrchestration } from "../src/recovery-orchestration.js";
import { RecoveryWarningFeed } from "../src/recovery-warning-feed.js";
import { WorkerApiError, type WorkerRecoveryWarning } from "../src/worker-api.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { createStoryViewModel, rowIndexForNode, rowPart } from "../src/model.js";
import { factRows } from "../src/facts-model.js";
import { applyOpeningFocus } from "../src/reading-position.js";
import { adoptReconciliationSnapshot } from "../src/story-adoption.js";
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
  test("cross-story recovery keeps the palette on NAV and drops its old selection", async () => {
    const source = demoAppSource();
    const fallback = source.stories.find((story) => story.id !== source.payload.id)!;
    const recoveredPayload = { ...source.payload, id: fallback.id, title: fallback.title };
    const connection = controlledMonitor(source.api, {
      down: true,
      attempt: 1,
      nextRetryAt: null,
      error: "offline"
    });
    source.connection = connection.monitor;
    source.api.listStories = async () => [fallback];
    const entered = deferred<void>();
    const recovered = deferred<StoryPayload>();
    source.api.loadStory = async () => {
      entered.resolve();
      return recovered.promise;
    };

    const state = initialState(source, false);
    state.mode = "FACTS";
    state.facts = {
      cursor: 0,
      query: "",
      chip: 0,
      selectedTag: null,
      filtering: false,
      deleteArmedId: null
    };
    const cache = createWrapCache<ProseStyle>();
    const press = (event: KeyEvent) => handleKey(
      event,
      state,
      source,
      cache,
      () => undefined,
      async () => undefined,
      () => undefined
    );
    await press(ctrlP());
    const palette = state.commands;
    if (palette === null) throw new Error("palette did not open");
    palette.selection = {
      text: "old story text",
      spans: [{ key: "old:text", text: "old story text", start: 0, end: 15 }]
    };

    const adopted = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === recoveredPayload) adopted.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({
      state,
      source,
      backend,
      cache,
      repaint
    });

    connection.publish(connectionSucceeded());
    await entered.promise;
    recovered.resolve(recoveredPayload);
    await adopted.promise;

    expect(state.payload).toBe(recoveredPayload);
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).toBe(palette);
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.commands?.selection ?? null).toBeNull();

    await typeQuery(press, "new Fact from selection");
    expect(state.commands?.selectedId).not.toBe("new-fact-from-selection");

    await press(key("escape", "\u001b"));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
    stop();
  });

  test("cross-story recovery restores an unsent Direct draft beneath the palette", async () => {
    const source = demoAppSource();
    const fallback = source.stories.find((story) => story.id !== source.payload.id)!;
    const recoveredPayload = { ...source.payload, id: fallback.id, title: fallback.title };
    const connection = controlledMonitor(source.api, {
      down: true,
      attempt: 1,
      nextRetryAt: null,
      error: "offline"
    });
    source.connection = connection.monitor;
    source.api.listStories = async () => [fallback];
    const entered = deferred<void>();
    const recovered = deferred<StoryPayload>();
    source.api.loadStory = async () => {
      entered.resolve();
      return recovered.promise;
    };

    const state = initialState(source, false);
    state.mode = "COMPOSE";
    const draft = "keep this Direct draft";
    setComposerText(state.composer, draft);
    const cache = createWrapCache<ProseStyle>();
    const press = (event: KeyEvent) => handleKey(
      event,
      state,
      source,
      cache,
      () => undefined,
      async () => undefined,
      () => undefined
    );
    await press(ctrlP());
    const palette = state.commands;
    if (palette === null) throw new Error("palette did not open");
    expect(palette.returnMode).toBe("COMPOSE");
    palette.selection = {
      text: "old story text",
      spans: [{ key: "old:text", text: "old story text", start: 0, end: 15 }]
    };

    const adopted = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === recoveredPayload) adopted.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({ state, source, backend, cache, repaint });

    connection.publish(connectionSucceeded());
    await entered.promise;
    recovered.resolve(recoveredPayload);
    await adopted.promise;

    expect(state.payload).toBe(recoveredPayload);
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).toBe(palette);
    expect(state.commands?.returnMode).toBe("COMPOSE");
    expect(state.commands?.selection ?? null).toBeNull();
    expect(state.retakePrompt).toBeNull();
    expect(state.pendingGenerationDraft).toBeNull();

    await press(key("escape", "\u001b"));
    expect(state.mode).toBe("COMPOSE");
    expect(state.commands).toBeNull();
    expect(state.composer.text).toBe(draft);
    stop();
  });

  test("cross-story recovery keeps a Library rename draft behind the palette", async () => {
    const source = demoAppSource();
    const fallback = source.stories.find((story) => story.id !== source.payload.id)!;
    const recoveredPayload = { ...source.payload, id: fallback.id, title: fallback.title };
    const connection = controlledMonitor(source.api, {
      down: true,
      attempt: 1,
      nextRetryAt: null,
      error: "offline"
    });
    source.connection = connection.monitor;
    source.api.listStories = async () => [fallback];
    const entered = deferred<void>();
    const recovered = deferred<StoryPayload>();
    source.api.loadStory = async () => {
      entered.resolve();
      return recovered.promise;
    };

    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const press = (event: KeyEvent) => handleKey(
      event,
      state,
      source,
      cache,
      () => undefined,
      async () => undefined,
      () => undefined
    );
    await press(key("o"));
    const library = state.library;
    if (library === null) throw new Error("Library did not open");
    library.cursor = library.stories.findIndex((story) => story.id === fallback.id);
    await press(key("e"));
    const prompt = library.prompt;
    if (prompt?.kind !== "rename") throw new Error("Library rename did not open");
    setComposerText(prompt.composer, "draft story title");
    await press(ctrlP());

    const palette = state.commands;
    if (palette === null) throw new Error("palette did not open");
    expect(palette.returnMode).toBe("LIBRARY");

    const adopted = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === recoveredPayload) adopted.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({ state, source, backend, cache, repaint });

    connection.publish(connectionSucceeded());
    await entered.promise;
    recovered.resolve(recoveredPayload);
    await adopted.promise;

    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).toBe(palette);
    expect(state.commands?.returnMode).toBe("LIBRARY");
    expect(state.library).toBe(library);
    expect(state.library?.prompt).toBe(prompt);
    expect(state.library?.prompt?.kind === "rename"
      ? state.library.prompt.composer.text
      : null).toBe("draft story title");

    await press(key("escape", "\u001b"));
    expect(state.mode).toBe("LIBRARY");
    expect(state.library).toBe(library);
    expect(state.library?.prompt).toBe(prompt);
    stop();
  });

  test("cross-story recovery keeps an unsaved Settings field behind the tag manager", async () => {
    const source = demoAppSource();
    const fallback = source.stories.find((story) => story.id !== source.payload.id)!;
    const recoveredPayload = { ...source.payload, id: fallback.id, title: fallback.title };
    const connection = controlledMonitor(source.api, {
      down: true,
      attempt: 1,
      nextRetryAt: null,
      error: "offline"
    });
    source.connection = connection.monitor;
    source.api.listStories = async () => [fallback];
    const entered = deferred<void>();
    const recovered = deferred<StoryPayload>();
    source.api.loadStory = async () => {
      entered.resolve();
      return recovered.promise;
    };

    const state = initialState(source, false);
    state.config = { ...state.config, settingsViewMode: "advanced" };
    source.config = state.config;
    const cache = createWrapCache<ProseStyle>();
    const press = (event: KeyEvent) => handleKey(
      event,
      state,
      source,
      cache,
      () => undefined,
      async () => undefined,
      () => undefined
    );
    await press(key(","));
    const modelRow = SETTINGS_ROW_IDS.indexOf("model");
    while (state.settings!.cursor < modelRow) await press(key("down"));
    await press(key("return", "\r"));
    const settings = state.settings;
    const edit = settings?.edit;
    if (settings === null || edit == null) throw new Error("Settings field did not open");
    setComposerText(edit.composer, "unsaved model draft");
    await press(ctrlP());

    const palette = state.commands;
    if (palette === null) throw new Error("palette did not open");
    expect(palette.returnMode).toBe("SETTINGS");
    await typeQuery(press, "tag manager");
    await press(key("return", "\r"));
    expect(state.commands).toBe(palette);
    expect(state.commands?.view).toBe("tags");
    const collidingTagNodeId = state.payload.tags[0]?.nodeId;
    if (collidingTagNodeId === undefined) throw new Error("recovery fixture needs a tag");
    palette.deleteArmedTagNodeId = collidingTagNodeId;
    const adopted = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === recoveredPayload) adopted.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({ state, source, backend, cache, repaint });

    connection.publish(connectionSucceeded());
    await entered.promise;
    recovered.resolve(recoveredPayload);
    await adopted.promise;

    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).toBe(palette);
    expect(state.commands?.returnMode).toBe("SETTINGS");
    expect(state.commands?.view).toBe("tags");
    expect(state.commands?.deleteArmedTagNodeId).toBe(null);
    expect(state.settings).toBe(settings);
    expect(state.settings?.edit).toBe(edit);
    expect(state.settings?.edit?.composer.text).toBe("unsaved model draft");
    await press(key("D"));
    expect(state.commands?.deleteArmedTagNodeId).toBe(collidingTagNodeId);
    await press(key("escape", "\u001b"));

    await press(key("escape", "\u001b"));
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).toBe(palette);
    expect(state.commands?.view).toBe("commands");
    expect(state.settings?.edit?.composer.text).toBe("unsaved model draft");
    await press(key("escape", "\u001b"));
    expect(state.mode).toBe("SETTINGS");
    expect(state.settings?.edit).toBe(edit);
    expect(state.settings?.edit?.composer.text).toBe("unsaved model draft");
    stop();
  });

  test("cross-story recovery keeps a global Settings prompt behind the palette", async () => {
    const source = demoAppSource();
    const fallback = source.stories.find((story) => story.id !== source.payload.id)!;
    const recoveredPayload = { ...source.payload, id: fallback.id, title: fallback.title };
    const connection = controlledMonitor(source.api, {
      down: true,
      attempt: 1,
      nextRetryAt: null,
      error: "offline"
    });
    source.connection = connection.monitor;
    source.api.listStories = async () => [fallback];
    const entered = deferred<void>();
    const recovered = deferred<StoryPayload>();
    source.api.loadStory = async () => {
      entered.resolve();
      return recovered.promise;
    };

    const state = initialState(source, false);
    state.config = { ...state.config, settingsViewMode: "advanced" };
    source.config = state.config;
    const cache = createWrapCache<ProseStyle>();
    const press = (event: KeyEvent) => handleKey(
      event,
      state,
      source,
      cache,
      () => undefined,
      async () => undefined,
      () => undefined
    );
    await press(key(","));
    const row = SETTINGS_ROW_IDS.indexOf("default-author-brief");
    while (state.settings!.cursor < row) await press(key("down"));
    await press(key("return", "\r"));
    const settings = state.settings;
    const editor = state.editor;
    if (settings === null
      || state.mode !== "EDITOR"
      || editor?.kind !== "document"
      || editor.target.kind !== "settings-prompt") {
      throw new Error("global Settings prompt did not open");
    }
    setComposerText(editor.composer, "unsaved global prompt");
    await press(ctrlP());

    const palette = state.commands;
    if (palette === null) throw new Error("palette did not open");
    expect(palette.returnMode).toBe("EDITOR");
    const adopted = deferred<void>();
    const repaint = () => {
      if (state.backendTask === null && state.payload === recoveredPayload) adopted.resolve();
    };
    const backend = new ActionRuntime(state, repaint);
    const stop = startRecoveryOrchestration({ state, source, backend, cache, repaint });

    connection.publish(connectionSucceeded());
    await entered.promise;
    recovered.resolve(recoveredPayload);
    await adopted.promise;

    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).toBe(palette);
    expect(state.commands?.returnMode).toBe("EDITOR");
    expect(state.settings).toBe(settings);
    expect(state.editor).toBe(editor);
    expect(state.editor?.kind === "document" ? state.editor.composer.text : null)
      .toBe("unsaved global prompt");

    await press(key("escape", "\u001b"));
    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(editor);
    expect(state.editor?.kind === "document" ? state.editor.composer.text : null)
      .toBe("unsaved global prompt");
    stop();
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
