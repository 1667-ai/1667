import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { storyApiFromWorkerTransport } from "../../client/worker-story-api.js";
import { createWorkerHost } from "../../host/worker-host.js";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import { ActionRuntime } from "../src/action-runtime.js";
import type { AppSource } from "../src/app.js";
import { initialState } from "../src/app.js";
import { createComposer } from "../src/composer-model.js";
import { createConnectionMonitor } from "../src/connection.js";
import { normalizeUserConfig } from "../src/config.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { startRecoveryOrchestration } from "../src/recovery-orchestration.js";
import { adoptSameStoryPayload } from "../src/story-adoption.js";

describe("revision conflict recovery through the real worker transport", () => {
  for (const target of ["rename", "Aside"]) {
    test(`reloads after a stale ${target} request and keeps the local draft for retry`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "1667-tui-revision-conflict-"));
      const dataDir = path.join(root, "data");
      const machineDir = path.join(root, "machine");
      await mkdir(machineDir);
      const host = await createWorkerHost({ dataDir, machineDir });
      const raw = storyApiFromWorkerTransport(host.transport);
      const writer = storyApiFromWorkerTransport(host.transport);
      const connection = createConnectionMonitor(raw);
      const api = connection.api;
      let stopRecovery: (() => void) | null = null;
      let runtime: ActionRuntime | null = null;
      try {
        const created = await api.createStory("Conflict recovery");
        const seeded = await api.createNode(created.id, {
          parentId: null,
          text: "A seeded line for recovery."
        });
        const opened = await api.loadStory(seeded.id);
        const settings = await api.getSettings();
        if (!settings.editable) throw new Error("The fresh project settings are read-only.");
        await api.saveSettings({
          transportOperationId: `integration:${createDurableMutationId()}`,
          mutationId: createDurableMutationId(),
          expectedStateGeneration: settings.stateGeneration,
          document: applyBasicSettingsDraft(settings.document, {
            ...settings.effective,
            provider: "openai-compatible",
            baseUrl: "https://127.0.0.1:1/v1",
            model: "missing",
            apiKeyEnv: null
          })
        });
        const savedSettings = await api.getSettings();
        const source: AppSource = {
          payload: opened,
          api,
          demo: false,
          stories: await api.listStories(),
          settingsView: savedSettings,
          settings: savedSettings.effective,
          storyFolder: "",
          exportDirectory: process.cwd(),
          connection,
          config: normalizeUserConfig({ updates: { mode: "notify" } }),
          readingPositions: {}
        };
        const state = initialState(source, false);
        const cache = createWrapCache<ProseStyle>();
        runtime = new ActionRuntime(state, () => undefined);
        stopRecovery = startRecoveryOrchestration({
          state,
          source,
          backend: runtime,
          cache,
          repaint: () => undefined
        });

        let providerFailure: unknown;
        await runtime.run("naming story", async (task) => {
          try {
            await api.autonameStory(task.storyId);
          } catch (error) {
            providerFailure = error;
          }
        });
        expect((providerFailure as { code?: unknown } | undefined)?.code).toBe("provider_failure");

        await writer.loadStory(created.id);
        const remote = await writer.renameStory(created.id, "Remote title");
        const heldRevision = JSON.stringify(state.payload.aggregateVersion);
        state.mode = "COMPOSE";
        state.composer = createComposer("keep this draft");

        let conflict: unknown;
        await runtime.run("renaming story", async (task) => {
          try {
            if (target === "rename") await api.renameStory(task.storyId, "Local title");
            else await api.askAsideV2!({
              storyId: task.storyId, anchor: null, question: "Why?"
            }, () => undefined, undefined, new AbortController().signal);
          } catch (error) {
            conflict = error;
            state.toast = error instanceof Error ? error.message : String(error);
          }
        });
        expect((conflict as { code?: unknown } | undefined)?.code).toBe("revision_conflict");

        const deadline = Date.now() + 5_000;
        while (JSON.stringify(state.payload.aggregateVersion) === heldRevision) {
          if (Date.now() >= deadline) throw new Error("revision conflict did not trigger a TUI reload");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(state.payload.title).toBe(remote.title);
        expect(state.composer.text).toBe("keep this draft");

        await runtime.run("retrying rename", async (task) => {
          const payload = await api.renameStory(task.storyId, "Local title");
          if (task.storyCurrent()) {
            adoptSameStoryPayload(state, payload, cache);
          }
        });
        expect(state.payload.title).toBe("Local title");
        expect(state.composer.text).toBe("keep this draft");
      } finally {
        stopRecovery?.();
        runtime?.dispose();
        connection.dispose();
        await host.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
