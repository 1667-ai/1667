import { expect, test } from "bun:test";
import { ActionRuntime } from "../src/action-runtime.js";
import { sendAsideQuestion, clearAsideSurface } from "../src/aside-actions.js";
import { asideNotes, createAsideSurface } from "../src/aside-surface.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import type { StoryApi } from "../src/api.js";
import { createUnusedTakesPrunePlan } from "../src/prune-model.js";
import { confirmPrune } from "../src/story-mutations.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

test("Aside adopts mutation payloads before the next optimistic Prune", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.mode = "ASIDE";
  state.aside = createAsideSurface(state.payload.id, state.payload.title);
  const cache = createWrapCache<ProseStyle>();
  const askedAt = "2026-08-12T00:00:01.000Z";
  const clearedAt = "2026-08-12T00:00:02.000Z";
  const askedPayload = { ...state.payload, updatedAt: askedAt };
  const clearedPayload = { ...askedPayload, updatedAt: clearedAt };
  let pruneRevision: string | undefined;
  const api: StoryApi = {
    ...source.api,
    loadStory: async () => {
      throw new Error("unexpected fallback refresh");
    },
    askAside: async (_id, question) => ({
      notes: [{ question, answer: "Answer." }],
      payload: askedPayload
    }),
    clearAside: async () => clearedPayload,
    pruneUnusedTakes: async (_id, body) => {
      pruneRevision = body.expectedStoryRevision;
      return clearedPayload;
    }
  };
  const context = {
    backend: new ActionRuntime(state, () => undefined),
    cache,
    repaint: () => undefined,
    renderer: null,
    applyTheme: () => undefined,
    previewTheme: () => undefined
  };

  await sendAsideQuestion(state, api, "Why?", { cache });
  expect(state.payload.updatedAt).toBe(askedAt);
  expect(asideNotes(state.aside!)).toEqual([{ question: "Why?", answer: "Answer." }]);

  await clearAsideSurface(state, api, cache);
  await clearAsideSurface(state, api, cache);
  expect(state.payload.updatedAt).toBe(clearedAt);

  state.prune = createUnusedTakesPrunePlan(state.payload);
  expect(state.prune).not.toBeNull();
  await confirmPrune(state, { ...source, api }, context);
  expect(pruneRevision).toBe(clearedAt);
  expect(state.prune).toBeNull();
});

test("Aside keeps a committed note when its payload refresh fails", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.mode = "ASIDE";
  state.aside = createAsideSurface(state.payload.id, state.payload.title);
  const api: StoryApi = {
    ...source.api,
    loadStory: async () => {
      throw new Error("transient refresh failure");
    },
    askAside: async (_id, question) => ({
      notes: [{ question, answer: "Committed." }]
    })
  };

  await sendAsideQuestion(state, api, "Why?", {
    cache: createWrapCache<ProseStyle>()
  });
  expect(asideNotes(state.aside!)).toEqual([{ question: "Why?", answer: "Committed." }]);
  expect(state.aside!.busy).toBeFalse();
});

test("Clear replay adopts its payload when the current Aside refresh fails", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const note = { question: "Visible?", answer: "Keep this." };
  state.mode = "ASIDE";
  state.aside = createAsideSurface(state.payload.id, state.payload.title, [note]);
  const refreshedAt = "2026-08-12T00:00:03.000Z";
  const api: StoryApi = {
    ...source.api,
    clearAside: async () => ({
      ...state.payload,
      updatedAt: refreshedAt,
      hasAside: true
    }),
    getAside: async () => {
      throw new Error("transient Aside refresh failure");
    }
  };

  await clearAsideSurface(state, api);
  await clearAsideSurface(state, api);

  expect(state.payload.updatedAt).toBe(refreshedAt);
  expect(asideNotes(state.aside!)).toEqual([note]);
  expect(state.aside!.busy).toBeFalse();
  expect(state.toast).toBe("transient Aside refresh failure");
});

test("Aside header adopts a reconciled same-story title", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.mode = "ASIDE";
  state.aside = createAsideSurface(state.payload.id, "Old title");
  const api: StoryApi = {
    ...source.api,
    clearAside: async () => ({
      ...state.payload,
      title: "Current title"
    })
  };

  await clearAsideSurface(state, api);
  await clearAsideSurface(state, api);

  expect(state.payload.title).toBe("Current title");
  expect(state.aside!.storyTitle).toBe("Current title");
});
