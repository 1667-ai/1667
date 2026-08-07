import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rewriteStreamDigest } from "../../shared/rewrite-partial-contract.js";
import { platformPerformanceBudget } from "../../test/performance-budget.js";
import { ActionRuntime } from "../src/action-runtime.js";
import type { AppSource } from "../src/app.js";
import { initialState } from "../src/app.js";
import { DEMO_SETTINGS_VIEW } from "../src/demo.js";
import {
  openRewriteComposer,
  requestRewriteStop,
  submitRewriteComposer
} from "../src/rewrite-action.js";
import { createWorkerStoryApi } from "../src/worker-api.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

/**
 * The partial-rewrite commit through the real embedded worker (issue #339):
 * the writer stops a selection rewrite mid-stream, the transport delivers
 * the withheld tail once at terminal settlement, and `commitPartialRewrite`
 * splices exactly the streamed prose into the original selected range —
 * recording the rewritten span — through the full durable mutation pipeline.
 * The dry-run provider streams one replacement word per ~15ms tick, one word
 * per selection word, so a Stop right after the first delta always lands
 * mid-stream.
 */
describe("partial rewrite commit through the real worker transport", () => {
  test("a stopped rewrite keeps the streamed partial inside the selected range", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-rewrite-stop-save-"));
    const backend = await createWorkerStoryApi({ dataDir });
    try {
      const api = backend.api;
      const created = await api.createStory("Rewrite stop save");
      const text = "The caravan crossed the high desert road while thin banners "
        + "of dust rose behind every wheel and every hoof, and the drivers "
        + "watched the horizon for the first sign of the storm they all felt "
        + "coming closer with the light.";
      const seeded = await api.createNode(created.id, { parentId: null, text });
      const node = seeded.path[0]!;
      const expected = "crossed the high desert road while thin banners "
        + "of dust rose behind every wheel and every hoof, and the drivers "
        + "watched the horizon for the first sign of the storm";
      const start = text.indexOf(expected);
      const end = start + expected.length;

      const arrived: string[] = [];
      const stoppedTails: string[] = [];
      let settleText: string | null = null;
      const realRewriteNode = api.rewriteNode.bind(api);
      api.rewriteNode = (storyId, nodeId, body, onDelta, signal, onCommitted, onStopped) =>
        realRewriteNode(
          storyId,
          nodeId,
          body,
          (delta) => {
            arrived.push(delta);
            onDelta(delta);
          },
          signal,
          onCommitted,
          (tail) => {
            stoppedTails.push(tail);
            onStopped?.(tail);
          }
        );
      const realCommitPartialRewrite = api.commitPartialRewrite.bind(api);
      api.commitPartialRewrite = (storyId, nodeId, streamedDigest, attemptId) => {
        settleText = streamedDigest;
        return realCommitPartialRewrite(storyId, nodeId, streamedDigest, attemptId);
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
          composeMaxHeight: null,
          quota: { date: "", words: 0 },
          updates: { mode: "notify", channel: "stable", skippedVersion: null }
        },
        readingPositions: {}
      };
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      const actionRuntime = new ActionRuntime(state, () => undefined);
      const prompt = openRewriteComposer(state, { node, start, end, expected });

      const running = submitRewriteComposer(
        state,
        source,
        { backend: actionRuntime, cache, repaint: () => undefined },
        prompt,
        { kind: "rewrite", start, end, expected },
        ""
      );
      const deadline = Date.now() + platformPerformanceBudget(5_000);
      while (arrived.join("").trim().length === 0) {
        if (Date.now() > deadline) throw new Error("The dry-run rewrite never delivered a word");
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      requestRewriteStop(state, () => undefined);
      await running;

      // The settle presented exactly the streamed bytes, tail included.
      const streamed = arrived.join("") + stoppedTails.join("");
      expect(stoppedTails.length <= 1).toBeTrue();
      expect(settleText).toBe(rewriteStreamDigest(streamed));

      // The partial replaced exactly the original selected range, in place,
      // and the replaced extent is recorded as a rewritten span.
      const partial = streamed.trim();
      expect(partial.length > 0).toBeTrue();
      const landed = state.payload.path[0]!;
      expect(landed.id).toBe(node.id);
      expect(landed.text).toBe(text.slice(0, start) + partial + text.slice(end));
      expect(landed.rewrittenSpans).toEqual([
        { start, end: start + partial.length }
      ]);
      expect(state.toast).toBe("rewrite stopped · streamed text kept");
      expect(state.stream).toBe(null);

      // The committed story is durable: a fresh load agrees byte for byte.
      const reloaded = await api.loadStory(created.id);
      expect(reloaded.path[0]!.text).toBe(landed.text);
    } finally {
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
