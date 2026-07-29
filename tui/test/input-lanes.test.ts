import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import type { StoryPayload, StorySummary } from "../../shared/types.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState, type AppSource } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { requestGenerationStop } from "../src/generation-action.js";
import { libraryRows } from "../src/library-model.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine } from "../src/screens/story/frame.js";
import { startSummary } from "../src/summary-action.js";
import { RecoveryWarningFeed } from "../src/recovery-warning-feed.js";
import { startRecoveryOrchestration } from "../src/recovery-orchestration.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { setComposerText } from "../src/composer-model.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function key(name: string, sequence = name, ctrl = false): KeyEvent {
  return { name, sequence, shift: false, ctrl, meta: false } as KeyEvent;
}

function harness(source: AppSource = demoAppSource(), onRepaint: (state: ReturnType<typeof initialState>) => void = () => undefined) {
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const repaint = () => onRepaint(state);
  const backend = new ActionRuntime(state, repaint);
  let quitRequests = 0;
  const press = (event: KeyEvent) => handleKey(
    event,
    state,
    source,
    cache,
    repaint,
    async () => requestGenerationStop(state, repaint),
    () => { quitRequests += 1; },
    null,
    () => undefined,
    () => undefined,
    backend
  );
  return { state, cache, backend, repaint, press, quitRequests: () => quitRequests };
}

describe("responsive input lanes", () => {
  test("navigation and compose editing run during a stalled take switch", async () => {
    const source = demoAppSource();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const switchLine = source.api.switchLine.bind(source.api);
    let switched: StoryPayload | null = null;
    source.api.switchLine = async (storyId, nodeId, options) => {
      entered.resolve();
      await gate.promise;
      switched = await switchLine(storyId, nodeId, options);
      return switched;
    };
    const { state, press } = harness(source);
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");

    const pending = press(key("right"));
    await entered.promise;
    expect(state.backendTask?.label).toBe("switching take");

    await press(key("g"));
    expect(state.focusIndex).toBe(0);
    await press(key("i"));
    await press(key("x"));
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("x");
    gate.resolve();
    await pending;

    expect(switched).not.toBe(null);
    expect(state.payload.path.map((node) => node.id)).toEqual(switched!.path.map((node) => node.id));
    expect(state.focusIndex).toBe(0);
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("x");
    expect(state.backendTask).toBe(null);
  });

  test("escape restores an empty-stream draft and later input survives reconciliation", async () => {
    const source = demoAppSource();
    const streamGate = deferred<void>();
    const streamEntered = deferred<void>();
    const reloadGate = deferred<StoryPayload>();
    const reloadEntered = deferred<void>();
    const signals: AbortSignal[] = [];
    source.api.continueStory = async (_storyId, _instruction, _genId, _target, _onDelta, activeSignal) => {
      signals.push(activeSignal);
      streamEntered.resolve();
      await streamGate.promise;
      return null;
    };
    source.api.loadStory = async () => {
      reloadEntered.resolve();
      return reloadGate.promise;
    };
    const { state, press } = harness(source);
    state.mode = "COMPOSE";
    setComposerText(state.composer, "keep this direction");

    const pending = press(key("return", "\r"));
    await streamEntered.promise;
    await press(key("escape", "\u001b"));
    expect(signals[0]?.aborted).toBeTrue();
    expect(state.stream).toBe(null);
    expect(state.abort).not.toBe(null);
    expect(state.backendTask?.label).toBe("generating prose");
    expect(state.composer.text).toBe("keep this direction");
    expect(state.mode).toBe("COMPOSE");
    expect(renderStoryScreen(state, { width: 80, height: 24 }).lines.some((line) =>
      plainLine(line).includes("keep this direction"))).toBeTrue();
    expect(state.focusIndex).toBeLessThan(createStoryViewModel(state.payload).rows.length);

    await press(key("escape", "\u001b"));
    expect(state.mode).toBe("NAV");
    await press(key("g"));
    expect(state.focusIndex).toBe(0);
    await press(key("i"));
    await press(key("!"));
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("keep this direction!");
    streamGate.resolve();
    await reloadEntered.promise;
    expect(state.backendTask?.label).toBe("generating prose");
    reloadGate.resolve(source.payload);
    await pending;

    expect(state.focusIndex).toBe(0);
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("keep this direction!");
    expect(state.abort).toBe(null);
    expect(state.backendTask).toBe(null);
  });

  test("a stalled library refresh cannot prevent close or resurrect its overlay", async () => {
    const source = demoAppSource();
    const entered = deferred<void>();
    const gate = deferred<StorySummary[]>();
    source.api.listStories = async () => {
      entered.resolve();
      return gate.promise;
    };
    const { state, press } = harness(source);

    const pending = press(key("o"));
    await entered.promise;
    expect(state.mode).toBe("LIBRARY");
    expect(state.library).not.toBe(null);

    await press(key("escape", "\u001b"));
    expect(state.mode).toBe("NAV");
    expect(state.library).toBe(null);
    gate.resolve(source.stories);
    await pending;

    expect(state.mode).toBe("NAV");
    expect(state.library).toBe(null);
  });

  test("a reopened library receives the first refresh without losing its selection", async () => {
    const source = demoAppSource();
    source.stories = [
      ...source.stories,
      { ...source.stories[0]!, id: "second-story", title: "second story" }
    ];
    const entered = deferred<void>();
    const gate = deferred<StorySummary[]>();
    source.api.listStories = async () => {
      entered.resolve();
      return gate.promise;
    };
    const { state, press } = harness(source);

    const pending = press(key("o"));
    await entered.promise;
    await press(key("escape", "\u001b"));
    await press(key("o"));
    state.library!.cursor = libraryRows(state.library!.stories, state.library!.query)
      .findIndex((story) => story.id === "second-story");
    expect(libraryRows(state.library!.stories, state.library!.query)[state.library!.cursor]?.id).toBe("second-story");

    const selected = source.stories.find((story) => story.id === "second-story")!;
    const refreshed = [selected, ...source.stories.filter((story) => story.id !== selected.id).reverse()];
    gate.resolve(refreshed);
    await pending;

    expect(state.library?.stories).toEqual(refreshed);
    expect(libraryRows(state.library!.stories, state.library!.query)[state.library!.cursor]?.id).toBe("second-story");
  });

  test("rename story opens atomically and keeps its frozen target through a reordered refresh", async () => {
    const source = demoAppSource();
    const currentId = source.payload.id;
    const currentTitle = source.payload.title;
    const current = source.stories.find((story) => story.id === currentId)!;
    source.stories = [...source.stories.filter((story) => story.id !== currentId), current];
    const refreshed = [source.stories[1]!, current, source.stories[0]!, source.stories[2]!];
    const entered = deferred<void>();
    const gate = deferred<StorySummary[]>();
    let catalogLoads = 0;
    source.api.listStories = async () => {
      catalogLoads += 1;
      if (catalogLoads === 1) {
        entered.resolve();
        return gate.promise;
      }
      return refreshed;
    };
    const renamed: Array<{ id: string; title: string }> = [];
    const app = harness(source);
    source.api.renameStory = async (id, title) => {
      renamed.push({ id, title });
      return { ...app.state.payload, title };
    };

    await app.press(key(":"));
    for (const character of "rename story") await app.press(key(character));
    const opening = app.press(key("return", "\r"));
    await entered.promise;

    const prompt = app.state.library?.prompt;
    expect(app.state.mode).toBe("LIBRARY");
    expect(prompt).toEqual({ kind: "rename", value: currentTitle, targetId: currentId });
    expect(libraryRows(app.state.library!.stories, "")[app.state.library!.cursor]?.id).toBe(currentId);
    expect(renderStoryScreen(app.state, { width: 120, height: 36 }).lines.map(plainLine).join("\n"))
      .toContain(`rename: ${currentTitle}`);

    gate.resolve(refreshed);
    await opening;

    expect(app.state.library?.prompt).toBe(prompt);
    expect(app.state.library?.stories).toBe(refreshed);
    expect(libraryRows(refreshed, "")[app.state.library!.cursor]?.id).toBe(currentId);
    await app.press(key("up"));
    expect(libraryRows(refreshed, "")[app.state.library!.cursor]?.id).not.toBe(currentId);
    for (const character of " renamed") await app.press(key(character));
    await app.press(key("return", "\r"));

    expect(renamed).toEqual([{ id: currentId, title: `${currentTitle} renamed` }]);
    expect(app.state.payload.title).toBe(`${currentTitle} renamed`);
    expect(app.state.library?.prompt).toBe(null);
  });

  test("recovery publishes into a Library opened while its owner is stalled", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    source.backendRecovery = feed;
    const entered = deferred<void>();
    const gate = deferred<StorySummary[]>();
    const recovered = source.stories.map((story, index) => index === 0
      ? { ...story, title: "recovered catalog title" }
      : story);
    source.api.listStories = async () => {
      entered.resolve();
      return gate.promise;
    };
    const settled = deferred<void>();
    const app = harness(source, (state) => {
      if (state.backendTask === null && state.library?.stories === recovered) settled.resolve();
    });
    const stop = startRecoveryOrchestration({
      state: app.state,
      source,
      backend: app.backend,
      invalidateCache: () => app.cache.invalidate(),
      repaint: app.repaint
    });

    feed.publish([], true);
    await entered.promise;
    await app.press(key("o"));
    expect(app.state.library?.stories).not.toBe(recovered);
    gate.resolve(recovered);
    await settled.promise;

    expect(source.stories).toBe(recovered);
    expect(app.state.library?.stories).toBe(recovered);
    expect(app.state.library?.stories[0]?.title).toBe("recovered catalog title");
    stop();
  });

  test("recovery publishes into Settings opened while its owner is stalled", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    source.backendRecovery = feed;
    const entered = deferred<void>();
    const gate = deferred<StorySummary[]>();
    const recovered = {
      ...source.settings,
      provider: "openai-compatible" as const,
      baseUrl: "https://models.example/v1",
      model: "recovered-model",
      contextWindow: 65_536
    };
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const recoveredView = {
      ...source.settingsView,
      document: applyBasicSettingsDraft(source.settingsView.document, recovered),
      effective: recovered
    };
    source.api.listStories = async () => {
      entered.resolve();
      return gate.promise;
    };
    source.api.getSettings = async () => recoveredView;
    const settled = deferred<void>();
    const app = harness(source, (state) => {
      if (state.backendTask === null
        && state.settings?.draft.generation.model === recovered.model) {
        settled.resolve();
      }
    });
    const stop = startRecoveryOrchestration({
      state: app.state,
      source,
      backend: app.backend,
      invalidateCache: () => app.cache.invalidate(),
      repaint: app.repaint
    });

    feed.publish([], true);
    await entered.promise;
    await app.press(key(","));
    expect(app.state.settings?.draft.generation).not.toBe(recovered);
    gate.resolve(source.stories);
    await settled.promise;

    expect(source.settings).toBe(recovered);
    expect(app.state.settings?.draft.generation).toEqual(recovered);
    expect(app.state.model).toBe("recovered-model");
    expect(app.state.contextWindow).toBe(65_536);
    stop();
  });

  test("completed prune clears only its own confirmation after later input", async () => {
    const source = demoAppSource();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const deleteNode = source.api.deleteNode.bind(source.api);
    source.api.deleteNode = async (storyId, nodeId, parts) => {
      entered.resolve();
      await gate.promise;
      return deleteNode(storyId, nodeId, parts);
    };
    const { state, press } = harness(source);
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");

    await press(key("d"));
    const plan = state.prune;
    const pending = press(key("d"));
    await entered.promise;
    await press(key("x"));
    expect(state.prune).toBe(plan);
    gate.resolve();
    await pending;

    expect(state.prune).toBe(null);
    expect(state.focusIndex).toBeLessThan(createStoryViewModel(state.payload).rows.length);
  });

  test("ordinary mutation adoption preserves a newer prompt while its target survives", async () => {
    const source = demoAppSource();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const switchLine = source.api.switchLine.bind(source.api);
    source.api.switchLine = async (storyId, nodeId, options) => {
      entered.resolve();
      await gate.promise;
      return switchLine(storyId, nodeId, options);
    };
    const { state, press } = harness(source);
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");

    const pending = press(key("right"));
    await entered.promise;
    await press(key("G", "G"));
    await press(key("t"));
    const prompt = state.tag;
    await press(key("!", "!"));
    gate.resolve();
    await pending;

    expect(state.mode).toBe("TAG");
    expect(state.tag).toBe(prompt);
    expect(state.tag?.name.endsWith("!")).toBeTrue();
    expect(state.tag?.existing).toBeTrue();
  });

  test("ordinary mutation adoption closes a newer prompt whose target was deleted", async () => {
    const source = demoAppSource();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const deleteNode = source.api.deleteNode.bind(source.api);
    source.api.deleteNode = async (storyId, nodeId, parts) => {
      entered.resolve();
      await gate.promise;
      return deleteNode(storyId, nodeId, parts);
    };
    const { state, press } = harness(source);
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p13");

    await press(key("d"));
    const pending = press(key("d"));
    await entered.promise;
    await press(key("escape", "\u001b"));
    await press(key("t"));
    expect(state.tag?.nodeId).toBe("p13");
    await press(key("!", "!"));
    gate.resolve();
    await pending;

    expect(state.tag).toBe(null);
    expect(state.mode).toBe("NAV");
    expect(state.focusIndex).toBeLessThan(createStoryViewModel(state.payload).rows.length);
  });

  test("tag deletion preserves label input entered while it settles", async () => {
    const source = demoAppSource();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const deleteBookmark = source.api.deleteBookmark.bind(source.api);
    source.api.deleteBookmark = async (storyId, nodeId) => {
      entered.resolve();
      await gate.promise;
      return deleteBookmark(storyId, nodeId);
    };
    const { state, press } = harness(source);
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p13");
    await press(key("t"));
    await press(key("return", "\r"));
    const prompt = state.tag!;
    expect(prompt.existing).toBeTrue();
    expect(prompt.choosingStatus).toBeTrue();

    const pending = press(key("d"));
    await entered.promise;
    const submittedStatusIndex = prompt.statusIndex;
    await press(key("right"));
    expect(prompt.statusIndex).not.toBe(submittedStatusIndex);
    gate.resolve();
    await pending;

    expect(state.mode).toBe("TAG");
    expect(state.tag).toBe(prompt);
    expect(state.tag?.existing).toBeFalse();
    expect(state.tag?.statusIndex).not.toBe(submittedStatusIndex);
  });

  test("summary cancel restores NAV while its authoritative reload keeps ownership", async () => {
    const source = demoAppSource();
    const createGate = deferred<string | null>();
    const createEntered = deferred<void>();
    const reloadGate = deferred<StoryPayload>();
    const reloadEntered = deferred<void>();
    const settled = deferred<void>();
    const signals: AbortSignal[] = [];
    let sawSummaryOwner = false;
    source.api.createSummaryTake = async (_storyId, _body, _onDelta, signal) => {
      signals.push(signal);
      createEntered.resolve();
      return createGate.promise;
    };
    source.api.loadStory = async () => {
      reloadEntered.resolve();
      return reloadGate.promise;
    };
    const app = harness(source, (state) => {
      if (state.backendTask?.label === "summarizing story") sawSummaryOwner = true;
      else if (sawSummaryOwner && state.backendTask === null) settled.resolve();
    });

    const pending = startSummary(app.state, source, app);
    await createEntered.promise;
    await app.press(key("escape", "\u001b"));
    expect(signals[0]?.aborted).toBeTrue();
    expect(app.state.mode).toBe("NAV");
    expect(app.state.summary).toBe(null);
    expect(app.state.abort).not.toBe(null);
    expect(app.state.backendTask?.label).toBe("summarizing story");
    await app.press(key("escape", "\u001b"));
    expect(app.state.toast).not.toBe("stopping · waiting for backend settlement");

    createGate.resolve(null);
    await reloadEntered.promise;
    expect(app.state.backendTask?.label).toBe("summarizing story");
    reloadGate.resolve(source.payload);
    await pending;
    await settled.promise;
    expect(app.state.abort).toBe(null);
    expect(app.state.backendTask).toBe(null);
    expect(app.state.mode).toBe("NAV");
    expect(app.state.toast).not.toBe("stopping · waiting for backend settlement");
  });

  test("a committed generation that beats cancellation stays silent", async () => {
    const source = demoAppSource();
    const entered = deferred<void>();
    const gate = deferred<void>();
    source.api.continueStory = async () => {
      entered.resolve();
      await gate.promise;
      return source.payload;
    };
    const { state, press } = harness(source);
    state.mode = "COMPOSE";

    const pending = press(key("return", "\r"));
    await entered.promise;
    await press(key("escape", "\u001b"));
    gate.resolve();
    await pending;

    expect(state.backendTask).toBe(null);
    expect(state.abort).toBe(null);
    expect(state.toast).toBe(null);
  });

  test("a refused backend send keeps the compose draft intact", async () => {
    const { state, backend, press } = harness();
    const gate = deferred<void>();
    const pending = backend.run("stalled mutation", async () => gate.promise);
    state.mode = "COMPOSE";
    setComposerText(state.composer, "keep this direction");

    await press(key("return", "\r"));
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("keep this direction");
    expect(state.toast).toBe("busy · stalled mutation still running");

    gate.resolve();
    await pending;
  });

  test("Ctrl+C bypasses a stalled backend owner", async () => {
    const { state, backend, press, quitRequests } = harness();
    const gate = deferred<void>();
    const pending = backend.run("stalled mutation", async () => gate.promise);
    const frame = renderStoryScreen(state, { width: 120, height: 36 }).lines;
    expect(frame.map(plainLine).join("\n")).toContain("working · stalled mutation");

    await press(key("c", "\u0003", true));
    expect(quitRequests()).toBe(1);
    gate.resolve();
    await pending;
  });
});
