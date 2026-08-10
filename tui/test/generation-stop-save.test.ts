import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { platformPerformanceBudget } from "../../test/performance-budget.js";
import { ActionRuntime } from "../src/action-runtime.js";
import type { AppSource } from "../src/app.js";
import { DEMO_SETTINGS_VIEW } from "../src/demo.js";
import { generate, requestGenerationStop } from "../src/generation-action.js";
import { createWorkerStoryApi } from "../src/worker-api.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { initialState } from "../src/app.js";

/**
 * The Stop save through the real embedded worker, under the abort contract:
 * after the writer's Escape aborts the request signal, the transport never
 * calls `onDelta` again. Text that was already posted, or still inside the
 * worker's delta batcher, arrives once through `onStopped` at terminal
 * settlement instead, and `settleStoppedGeneration` commits all of it under
 * the generation's own ID. The dry-run provider streams a real word every
 * ~15ms for ~1280ms total, so a Stop after the first delta always lands
 * mid-stream.
 */
describe("stop save through the real worker transport", () => {
  test("a Stop saves every server-arrived byte without onDelta running after the abort", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-generation-stop-save-"));
    const backend = await createWorkerStoryApi({ dataDir });
    try {
      const api = backend.api;
      const created = await api.createStory("Stop save");
      const seeded = await api.createNode(created.id, { parentId: null, text: "Root prose." });

      let aborted = false;
      let deltaAfterAbort = false;
      let capturedGenId = "";
      const arrived: string[] = [];
      const stoppedTails: string[] = [];
      const realContinueStory = api.continueStory.bind(api);
      api.continueStory = (storyId, instruction, genId, target, onDelta, signal, callbacks = {}) => {
        capturedGenId = genId;
        return realContinueStory(storyId, instruction, genId, target, (text) => {
          if (aborted) deltaAfterAbort = true;
          arrived.push(text);
          onDelta(text);
        }, signal, {
          ...callbacks,
          onStopped: (text) => {
            stoppedTails.push(text);
            callbacks.onStopped?.(text);
          }
        });
      };

      const source: AppSource = {
        payload: seeded,
        api,
        demo: false,
        stories: [],
        settingsView: DEMO_SETTINGS_VIEW,
        settings: DEMO_SETTINGS_VIEW.effective,
        storyFolder: "",
        exportDirectory: process.cwd(),
        connection: null,
        config: {
          theme: "lantern",
          factsRail: "auto",
          composeFocus: "off",
          wordWrap: "on",
          composeMaxHeight: null,
          quota: { date: "", words: 0 },
          updates: { mode: "notify", channel: "stable", skippedVersion: null },
          lastRunVersion: null
        },
        readingPositions: {}
      };
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      const actionRuntime = new ActionRuntime(state, () => undefined);
      const rootId = seeded.path[0]!.id;

      const running = actionRuntime.run("generating prose", (task) =>
        generate(state, source, cache, () => undefined, "Continue.", null, null, task));
      const deadline = Date.now() + platformPerformanceBudget(5_000);
      while (arrived.join("").trim().length === 0) {
        if (Date.now() > deadline) throw new Error("The dry-run stream never delivered a word");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      aborted = true;
      requestGenerationStop(state, () => undefined);
      await running;

      // The live channel closed at the abort; whatever the worker had
      // already delivered or still held arrived once through onStopped.
      expect(deltaAfterAbort).toBeFalse();
      expect(stoppedTails.length <= 1).toBeTrue();

      // The Stop save committed every server-arrived byte under the
      // generation's own ID.
      const landed = state.payload.path.at(-1)!;
      expect(landed.id).not.toBe(rootId);
      expect(landed.genId).toBe(capturedGenId);
      expect(landed.text).toBe((arrived.join("") + stoppedTails.join("")).trim());
      expect(state.stream).toBe(null);
    } finally {
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
