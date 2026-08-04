import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KeyEvent } from "@opentui/core";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import { handleKey, initialState } from "../src/app.js";
import type { AppSource } from "../src/app.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createWorkerStoryApi, type WorkerStoryApi } from "../src/worker-api.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

/**
 * Issue #291 phase 4's end-to-end test: drive a real dry-run generation
 * through the embedded worker backend — the same StoryApi the interactive
 * TUI talks to, with no HTTP or spawned process — with the profile's
 * `tokenProbabilities` field set, then open the viewer and read the
 * rendered table off the frame. This is what makes the claim "the viewer
 * shows what the provider actually returned" true rather than assumed: the
 * capture, the storage, and the read route (phases 2 and 3) all run for
 * real here, not through a demo fixture standing in for them.
 */

function key(name: string): KeyEvent {
  return { name, sequence: name, shift: false, ctrl: false, meta: false } as KeyEvent;
}

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function embeddedBackend(): Promise<WorkerStoryApi> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-token-probabilities-e2e-"));
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

async function enableTokenProbabilities(
  api: WorkerStoryApi["api"],
  requested: number
): Promise<void> {
  const view = await api.getSettings();
  if (view.dataFormat !== 2 || !view.editable) throw new Error("expected an editable format-2 settings document");
  const profile = view.document.profiles.default;
  if (profile === undefined) throw new Error("expected a default generation profile");
  const mutationId = createDurableMutationId();
  await api.saveSettings({
    transportOperationId: `fixture:${mutationId}`,
    mutationId,
    expectedStateGeneration: view.stateGeneration,
    document: {
      ...view.document,
      profiles: {
        ...view.document.profiles,
        default: { ...profile, tokenProbabilities: requested }
      }
    }
  });
}

function appSource(api: WorkerStoryApi["api"], settingsView: Awaited<ReturnType<WorkerStoryApi["api"]["getSettings"]>>): AppSource {
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
      theme: "lantern",
      factsRail: "auto",
      composeFocus: "off",
      composeMaxHeight: null,
      quota: { date: "", words: 0 },
      updates: { mode: "notify", channel: "stable", skippedVersion: null }
    },
    readingPositions: {}
  };
}

describe("token probability viewer: end-to-end dry-run generation", () => {
  test("opening the viewer on a fresh dry-run take shows the real captured table", async () => {
    const backend = await embeddedBackend();
    const api = backend.api;
    const requested = 12;
    await enableTokenProbabilities(api, requested);

    const created = await api.createStory("Token probability fixture");
    const result = await api.continueStory(
      created.id,
      "Continue the passage.",
      "gen-token-probabilities-e2e",
      { parentId: null },
      () => {},
      new AbortController().signal
    );
    expect(result).not.toBe(null);
    const payload = result!.payload;
    const leaf = payload.path.at(-1)!;
    expect(payload.nodes.find((node) => node.id === leaf.id)?.tokenProbabilities).toBe(true);

    const settingsView = await api.getSettings();
    const source = appSource(api, settingsView);
    source.payload = payload;
    const state = initialState(source, false);
    state.focusIndex = rowIndexForNode(createStoryViewModel(payload), leaf.id);
    const cache = createWrapCache<ProseStyle>();
    await handleKey(key("l"), state, source, cache, () => {}, async () => {}, () => {});

    expect(state.mode).toBe("PROBS");
    expect(state.probs?.loading).toBe(false);
    expect(state.probs?.record).not.toBe(null);
    expect(state.probs?.record?.requested).toBe(requested);
    // The dry-run capture keeps every step's own token as its first
    // alternative (server/token-probability-capture.ts), so the very first
    // alternative row is always the one this table marks sampled.
    const firstToken = state.probs!.record!.steps[0]!.token;

    const frame = frameText(renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache }).lines);
    expect(frame).toContain("token probabilities");
    expect(frame).toContain(`logprobs · top ${requested}`);
    expect(frame).toContain("✓ sampled");
    expect(frame).toContain(firstToken.trim());
    expect(frame).toContain("←→");
    expect(frame).toContain("⇥");

    await handleKey(key("escape"), state, source, cache, () => {}, async () => {}, () => {});
    expect(state.mode).toBe("NAV");
    expect(state.probs).toBe(null);
  }, 30_000);

  test("a take generated before the setting was on shows the honest empty state, not a crash", async () => {
    const backend = await embeddedBackend();
    const api = backend.api;

    const created = await api.createStory("No token probabilities yet");
    const result = await api.continueStory(
      created.id,
      "Continue the passage.",
      "gen-token-probabilities-e2e-off",
      { parentId: null },
      () => {},
      new AbortController().signal
    );
    expect(result).not.toBe(null);
    const payload = result!.payload;
    const leaf = payload.path.at(-1)!;
    expect(payload.nodes.find((node) => node.id === leaf.id)?.tokenProbabilities).toBe(undefined);

    const settingsView = await api.getSettings();
    const source = appSource(api, settingsView);
    source.payload = payload;
    const state = initialState(source, false);
    state.focusIndex = rowIndexForNode(createStoryViewModel(payload), leaf.id);
    const cache = createWrapCache<ProseStyle>();
    await handleKey(key("l"), state, source, cache, () => {}, async () => {}, () => {});

    expect(state.mode).toBe("PROBS");
    expect(state.probs?.record).toBe(null);
    const frame = frameText(renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache }).lines);
    expect(frame).toContain(
      "Press , for Settings. Set alt count (alternatives per token) to 1–20. Save, then generate again."
    );
  }, 30_000);
});
