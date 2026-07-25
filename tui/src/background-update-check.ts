import { compareSemVer } from "../../shared/semver.js";
import { RELEASE_LAUNCHER_PACKAGE } from "../../shared/release-targets.js";
import {
  UPDATE_CHECK_INITIAL_DELAY_MS,
  createUpdateCacheEntry,
  updateFailureDelayMs,
  type UpdateCacheEntry,
  type UpdateCacheKey
} from "./update-cache.js";
import type { UpdatePreferences } from "./config.js";
import { UpgradeFailure } from "./upgrade-contract.js";
import {
  planUpgrade,
  type UpgradeObservation,
  type UpgradeRegistry
} from "./upgrade-plan.js";

type TimerHandle = ReturnType<typeof setTimeout>;

export interface BackgroundUpdateCheckDependencies {
  readonly preferences: UpdatePreferences;
  readonly observation: UpgradeObservation;
  readonly cacheKey: UpdateCacheKey;
  readonly registry: UpgradeRegistry;
  readonly readCache: () => Promise<UpdateCacheEntry | null>;
  readonly writeCache: (entry: UpdateCacheEntry) => Promise<unknown>;
  readonly onNotice: (message: string) => void;
  readonly onDebug?: (message: string) => void;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancel?: (timer: TimerHandle) => void;
}

/**
 * Start only after interactive rendering has been requested. The controller
 * owns no startup work and retries only explicitly retryable failures.
 */
export function startBackgroundUpdateCheck(
  dependencies: BackgroundUpdateCheckDependencies
): () => void {
  if (dependencies.preferences.mode === "off") return () => undefined;
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const schedule = dependencies.schedule ?? setTimeout;
  const cancel = dependencies.cancel ?? clearTimeout;
  let timer: TimerHandle | null = null;
  let activeController: AbortController | null = null;
  let disposed = false;
  let failureAttempt = 0;

  const queue = (delayMs: number) => {
    if (disposed) return;
    timer = schedule(() => {
      timer = null;
      void check();
    }, delayMs);
  };
  const check = async () => {
    if (disposed) return;
    const controller = new AbortController();
    activeController = controller;
    try {
      const cached = await dependencies.readCache();
      if (disposed) return;
      if (cached !== null) {
        publishNotice(cached.latest, dependencies);
        return;
      }

      const envelope = await planUpgrade({
        check: true,
        version: null,
        channel: dependencies.preferences.channel
      }, dependencies.observation, dependencies.registry, controller.signal);
      if (disposed) return;
      const entry = createUpdateCacheEntry(
        dependencies.cacheKey,
        envelope.latest,
        now()
      );
      await dependencies.writeCache(entry);
      if (disposed) return;
      publishNotice(envelope.latest, dependencies);
    } catch (error) {
      if (disposed) return;
      dependencies.onDebug?.(
        `background update check failed: ${error instanceof Error ? error.message : String(error)}`
      );
      if (error instanceof UpgradeFailure && error.retryable) {
        queue(updateFailureDelayMs(failureAttempt, random()));
        failureAttempt += 1;
      }
    } finally {
      if (activeController === controller) activeController = null;
    }
  };

  queue(UPDATE_CHECK_INITIAL_DELAY_MS);
  return () => {
    disposed = true;
    if (timer !== null) cancel(timer);
    timer = null;
    activeController?.abort();
    activeController = null;
  };
}

export function updateNotice(
  latest: string,
  observation: UpgradeObservation
): string | null {
  if (compareSemVer(latest, observation.currentVersion) <= 0) return null;
  return `1667 ${latest} available · see npmjs.com/package/${RELEASE_LAUNCHER_PACKAGE}`;
}

function publishNotice(
  latest: string,
  dependencies: Pick<
    BackgroundUpdateCheckDependencies,
    "preferences" | "observation" | "onNotice"
  >
): void {
  if (dependencies.preferences.skippedVersion === latest) return;
  const message = updateNotice(latest, dependencies.observation);
  if (message !== null) dependencies.onNotice(message);
}
