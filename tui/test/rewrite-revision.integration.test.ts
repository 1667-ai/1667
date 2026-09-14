import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkerHost } from "../../host/worker-host.js";
import { storyApiFromWorkerTransport } from "../../client/worker-story-api.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { initialState, type AppSource } from "../src/app.js";
import { normalizeUserConfig } from "../src/config.js";
import { DEMO_SETTINGS_VIEW } from "../src/demo.js";
import { createStoryViewModel } from "../src/model.js";
import { openRewriteComposer, requestRewriteStop, submitRewriteComposer } from "../src/rewrite-action.js";
import { streamPresentedText } from "../src/stream-text.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

for (const stop of [false, true]) {
  test(stop
    ? "a stopped TUI rewrite saves after a concurrent story edit"
    : "a completed TUI rewrite shows each replacement only once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "1667-rewrite-revision-"));
    const machineDir = path.join(root, "machine");
    await mkdir(machineDir);
    const host = await createWorkerHost({ dataDir: path.join(root, "data"), machineDir });
    const api = storyApiFromWorkerTransport(host.transport);
    const writer = storyApiFromWorkerTransport(host.transport);
    let runtime: ActionRuntime | undefined;
    try {
      const created = await api.createStory("Rewrite revision");
      const prefix = "Before the change: ";
      const selection = "a b c d e f g h i j";
      const suffix = ". The ending stays intact.";
      const seeded = await api.createNode(created.id, {
        parentId: null, text: prefix + selection + suffix
      });
      await writer.loadStory(created.id);
      const node = seeded.path[0]!;
      const source: AppSource = {
        payload: seeded, api, demo: false, stories: [],
        settingsView: DEMO_SETTINGS_VIEW, settings: DEMO_SETTINGS_VIEW.effective,
        storyFolder: "", exportDirectory: root, connection: null,
        config: normalizeUserConfig({ updates: { mode: "notify" } }), readingPositions: {}
      };
      const state = initialState(source, false);
      const frames: string[] = [];
      const repaint = () => {
        if (state.stream !== null && streamPresentedText(state.stream).length > 0) {
          frames.push(createStoryViewModel(state.payload, state.stream).parts[0]!.node.text);
        }
      };
      const rewriteNode = api.rewriteNode.bind(api);
      api.rewriteNode = (storyId, nodeId, body, onDelta, signal, onCommitted, callbacks = {}) =>
        rewriteNode(storyId, nodeId, body, onDelta, signal, onCommitted, {
          ...callbacks,
          onPayload: (payload) => {
            const adopted = callbacks.onPayload?.(payload);
            repaint();
            return adopted;
          }
        });
      runtime = new ActionRuntime(state, repaint);
      const range = { start: prefix.length, end: prefix.length + selection.length, expected: selection };
      const prompt = openRewriteComposer(state, { node, ...range });
      const running = submitRewriteComposer(state, source, {
        backend: runtime, cache: createWrapCache<ProseStyle>(), repaint
      }, prompt, { kind: "rewrite", ...range }, "");
      if (stop) {
        const deadline = Date.now() + 5_000;
        while (state.stream === null || state.stream.text.trim().length === 0) {
          if (Date.now() > deadline) throw new Error("The rewrite did not start.");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await writer.renameStory(created.id, "Changed while rewriting");
        requestRewriteStop(state, repaint);
      }
      await running;
      const saved = (await api.loadStory(created.id)).path[0]!.text;
      expect(state.payload.path[0]!.text).toBe(saved);
      expect(saved).not.toBe(node.text);
      expect(saved.startsWith(prefix)).toBeTrue();
      expect(saved.endsWith(suffix)).toBeTrue();
      if (stop) expect(state.payload.title).toBe("Changed while rewriting");
      else {
        expect(frames.length).toBeGreaterThan(0);
        const replacement = saved.slice(prefix.length, -suffix.length);
        for (const frame of frames) {
          expect(frame.startsWith(prefix)).toBeTrue();
          expect(frame.endsWith(suffix)).toBeTrue();
          expect(replacement.startsWith(frame.slice(prefix.length, -suffix.length))).toBeTrue();
        }
      }
    } finally {
      runtime?.dispose();
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
