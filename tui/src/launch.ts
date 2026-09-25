import type { StoryPayload, StorySummary } from "../../shared/types.js";
import type { StoryApi } from "./api.js";
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

/**
 * The TUI's input contract for a live backend: the embedded worker or an
 * HTTP attach, whichever `cli/src/main.ts` opened. `cli/` owns the backend —
 * it creates it and, once `startTui` returns, disposes it — so this type
 * never distinguishes worker from HTTP by shape; it only exposes what
 * `startTui` needs from either one.
 */
export interface TuiBackend {
  readonly api: StoryApi;
  /** Resolves only if the backend dies unexpectedly; null over HTTP, which
   *  has no such failure to await. */
  readonly failure: Promise<Error> | null;
  readonly readingPositionScope: {
    readonly dataDir: string | null;
    readonly origin: string | null;
  };
  readonly storyFolder: string;
  /** Where `/export` writes. The project root, or the working
   * directory when this client attached to a server instead of a project. */
  readonly exportDirectory: string;
  /** True when `error` is this backend's "no such story" answer. */
  isMissingStory(error: unknown): boolean;
  dispose(): Promise<void>;
}

interface StartTuiDemoOptions {
  readonly demo: true;
  readonly dense: boolean;
  readonly renderOnce: StartTuiRenderOnce | null;
}

interface StartTuiLiveOptions {
  readonly demo: false;
  readonly backend: TuiBackend;
  readonly storyId: string | null;
  readonly dense: boolean;
  readonly renderOnce: StartTuiRenderOnce | null;
  readonly backendRecovery: RecoveryWarningFeed;
}

export type StartTuiOptions = StartTuiDemoOptions | StartTuiLiveOptions;

/**
 * The TUI half of starting `1667`: build the app source (demo or live), then
 * run the render-once or interactive loop the CLI asked for, disposing every
 * resource this function created on the way out. `cli/src/main.ts` opens the
 * project, the Vault, and the backend, then hands the result here; it disposes
 * the backend itself once this returns.
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
  const { backend, backendRecovery } = options;
  const connection = createConnectionMonitor(backend.api);
  const api = connection.api;
  try {
    let [stories, settingsView] = await Promise.all([api.listStories(), api.getSettings()]);
    const storyId = options.storyId ?? newestStoryId(stories);
    // The old code's in-place sort ran only along this path, and its result
    // became `source.stories`; match that without mutating what
    // `api.listStories()` returned.
    if (options.storyId === null) stories = sortedByRecency(stories);
    let payload: StoryPayload;
    if (storyId === undefined) {
      payload = await backendRecovery.runRecoveryMutation(() => api.createStory());
      stories = await api.listStories();
    } else {
      try {
        payload = await api.loadStory(storyId);
      } catch (error) {
        if (options.storyId !== null || !backend.isMissingStory(error)) throw error;
        stories = await api.listStories();
        const fallbackId = newestStoryId(stories);
        stories = sortedByRecency(stories);
        payload = fallbackId === undefined ? await api.createStory() : await api.loadStory(fallbackId);
      }
    }
    const config = loadConfig();
    const storeFile = readingPositionStoreFile(
      backend.readingPositionScope.dataDir,
      backend.readingPositionScope.origin
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
      storyFolder: backend.storyFolder, exportDirectory: backend.exportDirectory, connection,
      ...(backend.failure === null ? {} : { backendFailure: backend.failure }),
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
      }
    };
  } catch (error) {
    connection.dispose();
    throw error;
  }
}

function sortedByRecency(stories: readonly StorySummary[]): StorySummary[] {
  return [...stories].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** Most recently updated story id, or undefined for an empty catalog. Copies
 *  before sorting, so it never mutates the caller's array. */
function newestStoryId(stories: readonly StorySummary[]): string | undefined {
  return sortedByRecency(stories)[0]?.id;
}
