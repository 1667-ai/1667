import type { StoryPayload } from "../../shared/types.js";
import type { StoryApi } from "./api.js";
import type { HttpAttach } from "../../client/http-attach.js";
import {
  WorkerApiError,
  type WorkerStoryApi
} from "../../host/embedded-story-api.js";
import { renderOnce, runInteractive, type AppSource } from "./app.js";
import { demoAppSource } from "./demo.js";
import { createConnectionMonitor } from "./connection.js";
import { loadConfig } from "./config.js";
import {
  configureReadingPositionStore,
  disposeReadingPositionStore,
  loadReadingPositions,
  readingPositionStoreFile
} from "./reading-position-store.js";
import { createBackgroundUpdateStarter } from "./update-runtime.js";
import type { RecoveryWarningFeed } from "./recovery-warning-feed.js";

/** `--render-once` dimensions and the synthetic key sequence to play first. */
export interface StartTuiRenderOnce {
  readonly width: number;
  readonly height: number;
  readonly keys: string;
}

interface StartTuiDemoOptions {
  readonly demo: true;
  readonly dense: boolean;
  readonly renderOnce: StartTuiRenderOnce | null;
}

interface StartTuiLiveOptions {
  readonly demo: false;
  readonly backendApi: StoryApi;
  readonly worker: WorkerStoryApi | null;
  readonly httpAttach: HttpAttach | null;
  readonly dataDir: string | null;
  readonly exportDirectory: string;
  readonly storyFolder: string;
  readonly storyId: string | null;
  readonly dense: boolean;
  readonly renderOnce: StartTuiRenderOnce | null;
  readonly backendRecovery: RecoveryWarningFeed;
}

export type StartTuiOptions = StartTuiDemoOptions | StartTuiLiveOptions;

/**
 * The TUI half of starting `1667`: build the app source (demo or live), then
 * run the render-once or interactive loop the CLI asked for, disposing every
 * backend resource on the way out. `cli/src/main.ts` opens the project, the
 * Vault, and the backend (the embedded worker or an HTTP attach), then hands
 * the result here.
 */
export async function startTui(options: StartTuiOptions): Promise<void> {
  const { source, dispose } = options.demo
    ? { source: demoAppSource(options.dense), dispose: async () => {} }
    : await buildLiveSource(options);
  try {
    if (options.renderOnce) {
      const { width, height, keys } = options.renderOnce;
      process.stdout.write(`${await renderOnce(source, width, height, keys)}\n`);
      return;
    }
    await runInteractive(source);
  } finally {
    await dispose();
  }
}

async function buildLiveSource(
  options: StartTuiLiveOptions
): Promise<{ source: AppSource; dispose: () => Promise<void> }> {
  const { backendApi, worker, httpAttach, dataDir, exportDirectory, storyFolder, backendRecovery } = options;
  const connection = createConnectionMonitor(backendApi);
  const api = connection.api;
  try {
    let [stories, settingsView] = await Promise.all([api.listStories(), api.getSettings()]);
    const storyId = options.storyId ?? stories
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id;
    let payload: StoryPayload;
    if (storyId === undefined) {
      payload = await backendRecovery.runRecoveryMutation(() => api.createStory());
      stories = await api.listStories();
    } else {
      try {
        payload = await api.loadStory(storyId);
      } catch (error) {
        if (worker === null || options.storyId !== null || !isWorkerNotFound(error)) throw error;
        stories = await api.listStories();
        const fallbackId = stories.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id;
        payload = fallbackId === undefined ? await api.createStory() : await api.loadStory(fallbackId);
      }
    }
    const config = loadConfig();
    const storeFile = readingPositionStoreFile(
      dataDir,
      httpAttach?.origin ?? null
    );
    configureReadingPositionStore(storeFile);
    const readingPositions = loadReadingPositions({ file: storeFile });
    const startUpdateCheck: NonNullable<AppSource["startUpdateCheck"]> = (
      currentConfig,
      onNotice
    ) => {
      try {
        return createBackgroundUpdateStarter(currentConfig)?.(onNotice) ?? (() => undefined);
      } catch {
        return () => undefined;
      }
    };
    const source: AppSource = {
      payload, api, demo: false,
      stories, settingsView, settings: settingsView.effective,
      storyFolder, exportDirectory, connection,
      ...(worker === null ? {} : { backendFailure: worker.failure }),
      backendRecovery,
      startUpdateCheck,
      config,
      readingPositions
    };
    return {
      source,
      dispose: async () => {
        disposeReadingPositionStore();
        connection.dispose();
        httpAttach?.dispose();
        await worker?.dispose();
      }
    };
  } catch (error) {
    connection.dispose();
    httpAttach?.dispose();
    await worker?.dispose();
    throw error;
  }
}

function isWorkerNotFound(error: unknown): boolean {
  return error instanceof WorkerApiError && error.status === 404;
}
