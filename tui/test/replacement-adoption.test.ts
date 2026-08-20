import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { StoryPayload } from "../../shared/types.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState, type AppSource } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { requestGenerationStop } from "../src/generation-action.js";
import { publishStories } from "../src/overlay-publication.js";
import { RecoveryWarningFeed } from "../src/recovery-warning-feed.js";
import { startRecoveryOrchestration } from "../src/recovery-orchestration.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { createComposer, setComposerText } from "../src/composer-model.js";
import { applyOpeningFocus } from "../src/reading-position.js";
import { adoptReconciliationSnapshot } from "../src/story-adoption.js";
import { SETTINGS_ROW_IDS } from "../src/settings-overlay-model.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function key(name: string, sequence = name): KeyEvent {
  return { name, sequence, shift: false, ctrl: false, meta: false } as KeyEvent;
}

function harness(
  source: AppSource,
  onRepaint: (state: ReturnType<typeof initialState>) => void = () => undefined
) {
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const repaint = () => onRepaint(state);
  const backend = new ActionRuntime(state, repaint);
  const press = (event: KeyEvent) => handleKey(event, state, source, cache, repaint,
    async () => requestGenerationStop(state, repaint), () => undefined,
    null, () => undefined, () => undefined, backend);
  return { state, cache, backend, repaint, press };
}

function deletionFixture() {
  const source = demoAppSource();
  const current = source.stories.find((story) => story.id === source.payload.id)!;
  const fallback = { ...current, id: "fallback-story", title: "fallback story" };
  const payload = { ...source.payload, id: fallback.id, title: fallback.title };
  const entered = deferred<void>();
  const gate = deferred<StoryPayload>();
  let deleted = false;
  source.stories = [current, fallback];
  source.api.listStories = async () => deleted ? [fallback] : [current, fallback];
  source.api.deleteStory = async () => { deleted = true; return { ok: true }; };
  source.api.loadStory = async () => { entered.resolve(); return gate.promise; };
  return { source, current, fallback, payload, entered, gate };
}

async function launchDelete(app: ReturnType<typeof harness>, fixture: ReturnType<typeof deletionFixture>) {
  await app.press(key("o"));
  await app.press(key("d"));
  const overlay = app.state.library!;
  const prompt = overlay.prompt!;
  if (prompt.kind !== "delete") throw new Error("expected delete prompt");
  prompt.value = fixture.current.title;
  const pending = app.press(key("return", "\r"));
  await fixture.entered.promise;
  return { overlay, prompt, pending };
}

describe("forced story replacement adoption", () => {
  test("catalog publication clears only prompts whose frozen target disappeared", () => {
    const source = demoAppSource();
    const current = source.stories.find((story) => story.id === source.payload.id)!;
    const survivor = { ...current, id: "surviving-story", title: "surviving story" };
    source.stories = [current, survivor];
    const app = harness(source);
    app.state.library = { stories: source.stories, cursor: 0, query: "", prompt: null };

    const filterPrompt = {
      kind: "filter" as const,
      initial: { query: "", cursor: 0, storyId: current.id }
    };
    app.state.library.query = "surv";
    app.state.library.prompt = filterPrompt;
    publishStories(app.state, source, [survivor]);
    expect(app.state.library.prompt).toBe(filterPrompt);

    const survivingPrompt = { kind: "rename" as const, composer: createComposer(survivor.title), targetId: survivor.id };
    app.state.library.prompt = survivingPrompt;
    publishStories(app.state, source, [survivor]);
    expect(app.state.library.prompt).toBe(survivingPrompt);

    app.state.library.prompt = { kind: "delete", value: current.title, targetId: current.id };
    publishStories(app.state, source, [survivor]);
    expect(app.state.library.prompt).toBe(null);
  });

  test("different-story adoption preserves a global inline settings draft", async () => {
    const source = demoAppSource();
    const app = harness(source);
    await app.press(key(","));
    // SETTINGS_ROW_IDS indexes the full (advanced) row list.
    app.state.settings!.viewMode = "advanced";
    const modelRow = SETTINGS_ROW_IDS.indexOf("model");
    while (app.state.settings!.cursor < modelRow) await app.press(key("down"));
    await app.press(key("return"));
    const edit = app.state.settings!.edit!;
    setComposerText(edit.composer, "local-model");

    adoptReconciliationSnapshot(app.state, {
      ...app.state.payload,
      id: "replacement-story",
      title: "replacement story"
    }, app.cache);

    expect(app.state.mode).toBe("SETTINGS");
    expect(app.state.editor).toBe(null);
    expect(app.state.settings?.edit).toBe(edit);
    expect(app.state.settings?.edit?.composer.text).toBe("local-model");
    expect(app.state.settings?.cursor).toBe(modelRow);
  });

  test("different-story adoption preserves the full-screen system prompt", async () => {
    const source = demoAppSource();
    const app = harness(source);
    await app.press(key(","));
    // SETTINGS_ROW_IDS indexes the full (advanced) row list.
    app.state.settings!.viewMode = "advanced";
    const row = SETTINGS_ROW_IDS.indexOf("system-prompt");
    for (let index = 0; index < row; index += 1) await app.press(key("down"));
    await app.press(key("return"));
    const session = app.state.editor;
    if (app.state.mode !== "EDITOR"
      || session?.kind !== "document"
      || session.target.kind !== "settings-prompt") {
      throw new Error("Settings editor did not open");
    }
    const settings = app.state.settings;
    setComposerText(session.composer, "Unsaved global prompt");

    adoptReconciliationSnapshot(app.state, {
      ...app.state.payload,
      id: "replacement-story",
      title: "replacement story"
    }, app.cache);

    expect(app.state.mode).toBe("EDITOR");
    expect(app.state.editor).toBe(session);
    expect(app.state.settings).toBe(settings);
    expect(app.state.settings?.edit).toBe(null);
    expect(app.state.editor?.composer.text).toBe("Unsaved global prompt");
  });

  test("a newer prompt for a story removed by a slow delete is reconciled away", async () => {
    const source = demoAppSource();
    const current = source.stories.find((story) => story.id === source.payload.id)!;
    const doomed = { ...current, id: "doomed-story", title: "doomed story" };
    const listEntered = deferred<void>();
    const listGate = deferred<typeof source.stories>();
    let deleting = false;
    source.stories = [current, doomed];
    source.api.deleteStory = async (storyId) => {
      expect(storyId).toBe(doomed.id);
      deleting = true;
      return { ok: true };
    };
    source.api.listStories = async () => {
      if (!deleting) return source.stories;
      listEntered.resolve();
      return listGate.promise;
    };
    const app = harness(source);

    await app.press(key("o"));
    const overlay = app.state.library!;
    overlay.cursor = 1;
    await app.press(key("d"));
    const submittedPrompt = overlay.prompt!;
    if (submittedPrompt.kind !== "delete") throw new Error("expected delete prompt");
    submittedPrompt.value = doomed.title;
    const pending = app.press(key("return", "\r"));
    await listEntered.promise;

    await app.press(key("escape", "\u001b"));
    await app.press(key("d"));
    const newerPrompt = overlay.prompt;
    expect(newerPrompt).not.toBe(submittedPrompt);
    expect(newerPrompt).toMatchObject({ kind: "delete", targetId: doomed.id });

    listGate.resolve([current]);
    await pending;

    expect(app.state.library).toBe(overlay);
    expect(overlay.stories).toEqual([current]);
    expect(overlay.prompt).toBe(null);
  });

  test("deleting the open story keeps compose input entered during fallback loading", async () => {
    const fixture = deletionFixture();
    const app = harness(fixture.source);
    const { pending } = await launchDelete(app, fixture);

    await app.press(key("escape", "\u001b"));
    await app.press(key("escape", "\u001b"));
    await app.press(key("g"));
    await app.press(key("i"));
    await app.press(key("x"));
    fixture.gate.resolve(fixture.payload);
    await pending;

    expect(app.state.payload.id).toBe(fixture.fallback.id);
    // Destination story opens at its stored/default reading position — not the
    // previous story's numeric row index.
    expect(app.state.focusIndex).toBe(
      applyOpeningFocus(app.state.payload, app.state.readingPositions)
    );
    expect(app.state.mode).toBe("COMPOSE");
    expect(app.state.composer.text).toBe("x");
    expect(app.state.library).toBe(null);
  });

  test("a new prompt on the same Library survives the submitted delete prompt", async () => {
    const fixture = deletionFixture();
    const app = harness(fixture.source);
    const { overlay, prompt: submittedPrompt, pending } = await launchDelete(app, fixture);

    await app.press(key("escape", "\u001b"));
    await app.press(key("/"));
    await app.press(key("x"));
    const filterPrompt = overlay.prompt;
    fixture.gate.resolve(fixture.payload);
    await pending;

    expect(filterPrompt).not.toBe(submittedPrompt);
    expect(app.state.payload.id).toBe(fixture.fallback.id);
    expect(app.state.mode).toBe("LIBRARY");
    expect(app.state.library).toBe(overlay);
    expect(app.state.library?.prompt).toBe(filterPrompt);
    expect(app.state.library?.prompt).toMatchObject({ kind: "filter" });
    expect(app.state.library?.query).toBe("x");
  });

  test("different-story recovery keeps a Library opened during fallback loading", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    const fallback = source.stories.find((story) => story.id !== source.payload.id)!;
    const payload = { ...source.payload, id: fallback.id, title: fallback.title };
    const entered = deferred<void>();
    const gate = deferred<StoryPayload>();
    const settled = deferred<void>();
    source.backendRecovery = feed;
    source.api.listStories = async () => [fallback];
    source.api.getSettings = async () => source.settingsView;
    source.api.loadStory = async () => { entered.resolve(); return gate.promise; };
    const app = harness(source, (state) => {
      if (state.backendTask === null && state.payload.id === fallback.id) settled.resolve();
    });
    const stop = startRecoveryOrchestration({ state: app.state, source, backend: app.backend,
      cache: app.cache, repaint: app.repaint });

    feed.publish([], true);
    await entered.promise;
    await app.press(key("o"));
    const opened = app.state.library!;
    opened.query = fallback.title;
    gate.resolve(payload);
    await settled.promise;

    expect(app.state.mode).toBe("LIBRARY");
    expect(app.state.library).toBe(opened);
    expect(app.state.library?.query).toBe(fallback.title);
    expect(app.state.library?.stories).toEqual([fallback]);
    stop();
  });

  test("different-story recovery preserves a compose draft that predates the task", async () => {
    const source = demoAppSource();
    const feed = new RecoveryWarningFeed();
    const fallback = source.stories.find((story) => story.id !== source.payload.id)!;
    const payload = { ...source.payload, id: fallback.id, title: fallback.title };
    const settled = deferred<void>();
    source.backendRecovery = feed;
    source.api.listStories = async () => [fallback];
    source.api.getSettings = async () => source.settingsView;
    source.api.loadStory = async () => payload;
    const app = harness(source, (state) => {
      if (state.backendTask === null && state.payload.id === fallback.id) settled.resolve();
    });
    app.state.mode = "COMPOSE";
    setComposerText(app.state.composer, "draft before recovery");
    app.state.focusIndex = 0;
    const stop = startRecoveryOrchestration({ state: app.state, source, backend: app.backend,
      cache: app.cache, repaint: app.repaint });

    feed.publish([], true);
    await settled.promise;

    expect(app.state.payload.id).toBe(fallback.id);
    expect(app.state.mode).toBe("COMPOSE");
    expect(app.state.composer.text).toBe("draft before recovery");
    expect(app.state.focusIndex).toBe(
      applyOpeningFocus(app.state.payload, app.state.readingPositions)
    );
    stop();
  });
});
