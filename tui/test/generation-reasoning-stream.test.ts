import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { platformPerformanceBudget } from "../../test/performance-budget.js";
import { ActionRuntime } from "../src/action-runtime.js";
import type { AppSource } from "../src/app.js";
import { initialState } from "../src/app.js";
import { DEMO_SETTINGS_VIEW } from "../src/demo.js";
import { generate } from "../src/generation-action.js";
import { createWorkerStoryApi } from "../src/worker-api.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

/**
 * The reasoning ("thinking") channel through the real embedded worker: the
 * dry-run provider fabricates a short synthetic reasoning burst ahead of its
 * prose (server/providers.ts's `streamDryRun`), and this exercises the whole
 * spine a user's stream actually takes — worker IPC's sequenced delta
 * channel, `tui/src/worker-transport.ts`'s routing, and
 * `appendStreamReasoning` — landing on `state.stream.reasoning`, structurally
 * apart from `state.stream.text`. No rendering is exercised; this is the
 * model layer a renderer would read from.
 */
describe("reasoning stream through the real worker transport", () => {
  test("dry-run reasoning lands on state.stream.reasoning, counted, and never inside story prose", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-generation-reasoning-"));
    const backend = await createWorkerStoryApi({ dataDir });
    try {
      const api = backend.api;
      const created = await api.createStory("Reasoning stream");
      const seeded = await api.createNode(created.id, { parentId: null, text: "Root prose." });

      const reasoningDeltas: Array<{ text: string; tokenCount: number }> = [];
      const proseDeltas: string[] = [];
      const realContinueStory = api.continueStory.bind(api);
      api.continueStory = (storyId, instruction, genId, target, onDelta, signal, onStopped, onReasoning, onReasoningStopped) =>
        realContinueStory(storyId, instruction, genId, target, (text) => {
          proseDeltas.push(text);
          onDelta(text);
        }, signal, onStopped, (delta) => {
          reasoningDeltas.push(delta);
          onReasoning?.(delta);
        }, onReasoningStopped);

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
          updates: { mode: "notify", channel: "stable", skippedVersion: null }
        },
        readingPositions: {}
      };
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      const actionRuntime = new ActionRuntime(state, () => undefined);

      let sawReasoningWhileStreaming = false;
      const running = actionRuntime.run("generating prose", (task) =>
        generate(state, source, cache, () => {
          if (state.stream?.reasoning !== undefined && state.stream.reasoning.text.length > 0) {
            sawReasoningWhileStreaming = true;
          }
        }, "Continue.", null, null, task));

      const deadline = Date.now() + platformPerformanceBudget(5_000);
      while (proseDeltas.join("").trim().length === 0) {
        if (Date.now() > deadline) throw new Error("The dry-run stream never delivered a word");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await running;

      expect(reasoningDeltas.length).toBeGreaterThan(0);
      expect(sawReasoningWhileStreaming).toBeTrue();

      const reasoningText = reasoningDeltas.map((delta) => delta.text).join("");
      const proseText = proseDeltas.join("");
      expect(reasoningText).toContain("dry-run");
      // Kept structurally apart at every hop: neither stream's text ever
      // contains the other's.
      expect(proseText.includes(reasoningText.trim())).toBeFalse();
      expect(reasoningText.includes(proseText.trim())).toBeFalse();

      // The running token count only ever grows.
      for (let index = 1; index < reasoningDeltas.length; index += 1) {
        expect(reasoningDeltas[index]!.tokenCount >= reasoningDeltas[index - 1]!.tokenCount).toBeTrue();
      }

      // The committed take's prose never carries a trace of the reasoning
      // text — reasoning has no persistence in this pass, and it must never
      // leak into what does get persisted.
      const landed = state.payload.path.at(-1)!;
      expect(landed.text.includes(reasoningText.trim())).toBeFalse();
    } finally {
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
