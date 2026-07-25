import type { GenerationSettings, StorySummary } from "../../shared/types.js";
import type { SettingsView } from "../../shared/settings-v2-types.js";
import type { ActionRunner, ActionTask } from "./action-runtime.js";
import type { StoryApi } from "./api.js";
import type { ConnectionMonitor } from "./connection.js";
import type { RecoveryWarningFeed } from "./recovery-warning-feed.js";
import type { BackendTaskKind, RuntimeState } from "./state.js";
import { adoptReconciliationSnapshot } from "./story-adoption.js";
import type { WorkerRecoveryWarning } from "./worker-api.js";
import { publishSettingsView, publishStories } from "./overlay-publication.js";

interface RecoverySource {
  api: StoryApi;
  demo: boolean;
  stories: StorySummary[];
  settingsView: SettingsView;
  settings: GenerationSettings;
  connection: ConnectionMonitor | null;
  backendRecovery?: RecoveryWarningFeed;
}

export interface RecoveryOrchestrationOptions {
  state: RuntimeState;
  source: RecoverySource;
  backend: ActionRunner;
  invalidateCache(): void;
  repaint(): void;
}

export interface RecoveryOrchestration {
  (): void;
  retry(): Promise<void>;
}

type ReconciliationOrigin = "automatic" | "warning" | "explicit";

interface ReconciliationLease {
  readonly origin: ReconciliationOrigin;
  readonly epoch: number;
  readonly intent: number;
  readonly storyId: string;
  epochCurrent(): boolean;
  current(): boolean;
}

interface ReconciliationSnapshot {
  payload: RuntimeState["payload"];
  stories: StorySummary[];
  settingsView: SettingsView;
}

interface ReconciliationResult {
  changedStory: boolean;
  interactionStable: boolean;
  storyId: string;
}

type ReconciliationOutcome = {
  epoch: number;
  intent: number;
} & ({
  kind: "adopted";
  result: ReconciliationResult;
} | {
  kind: "failed";
  error: unknown;
});

type OutcomeDisposition = "current" | "superseded" | "offline" | "stopped";

interface ExplicitProbe {
  taskId: number;
  handledTransition: boolean;
}

const activeOrchestrations = new WeakMap<RuntimeState, RecoveryOrchestration>();

/** Own every backend-state reconciliation intent for one interactive app.
 * Automatic transitions, durable recovery warnings, and explicit retry all
 * publish through the same epoch-fenced commit path. */
export function startRecoveryOrchestration(options: RecoveryOrchestrationOptions): RecoveryOrchestration {
  const { state, source, backend, invalidateCache, repaint } = options;
  let stopped = false;
  let connectionEpoch = 0;
  let reconnectRefreshScheduled = false;
  let reconnectIntent = 0;
  let settledReconnectIntent = 0;
  let explicitProbe: ExplicitProbe | null = null;

  const leaseFor = (task: ActionTask, origin: ReconciliationOrigin): ReconciliationLease => {
    const epoch = connectionEpoch;
    const intent = reconnectIntent;
    const taskKind: BackendTaskKind = origin === "explicit"
      ? "explicit-retry"
      : "connection-reconcile";
    const epochCurrent = () => !stopped
      && !state.connection.down
      && connectionEpoch === epoch
      && state.backendTask?.kind === taskKind
      && task.owns();
    return {
      origin,
      epoch,
      intent,
      storyId: task.storyId,
      epochCurrent,
      current: () => epochCurrent() && task.storyCurrent()
    };
  };

  const reconcileOwned = async (
    task: ActionTask,
    origin: ReconciliationOrigin
  ): Promise<ReconciliationOutcome | null> => {
    while (!stopped && task.owns() && task.storyCurrent() && !state.connection.down) {
      const lease = leaseFor(task, origin);
      try {
        const result = await reconcileCurrentBackendState(
          state, source, task, lease, invalidateCache
        );
        // The snapshot publication and this continuation are separated by an
        // async return. Recheck the lease here so an already-queued transition
        // stays inside the same ActionRuntime owner.
        // A successful reconciliation may intentionally adopt a surviving
        // replacement story, so only epoch/owner (not the old story id) remains
        // mandatory after its atomic commit.
        if (result !== null && lease.epochCurrent()) {
          return { kind: "adopted", epoch: lease.epoch, intent: lease.intent, result };
        }
      } catch (error) {
        // A request from an older connection epoch is not authoritative even
        // when it rejects. If a newer up transition already exists, keep the
        // same backend owner and load that epoch before exposing idle state.
        if (!stopped && task.owns() && task.storyCurrent()
          && !state.connection.down && connectionEpoch !== lease.epoch) continue;
        if (!stopped && task.owns() && task.storyCurrent()) {
          return { kind: "failed", epoch: lease.epoch, intent: lease.intent, error };
        }
        return null;
      }
      if (stopped || !task.owns() || !task.storyCurrent() || state.connection.down) return null;
      // The mandatory lease can fail only because a newer connection event
      // superseded it. Stay inside this owner and reconcile the latest epoch.
    }
    return null;
  };

  /** Settle only the intent observed by this result. The caller performs this
   * immediately after its await, then drains any newer epoch before releasing
   * the backend owner. */
  const settleOutcome = (task: ActionTask, outcome: ReconciliationOutcome): OutcomeDisposition => {
    settledReconnectIntent = Math.max(settledReconnectIntent, outcome.intent);
    const storyCurrent = outcome.kind === "adopted"
      ? state.payload.id === outcome.result.storyId
      : task.storyCurrent();
    if (stopped || !task.owns() || !storyCurrent) return "stopped";
    if (state.connection.down) return "offline";
    if (connectionEpoch !== outcome.epoch || settledReconnectIntent < reconnectIntent) {
      return "superseded";
    }
    return "current";
  };

  const refreshAfterRecovery = async (warnings: readonly WorkerRecoveryWarning[]): Promise<void> => {
    for (const warning of warnings) {
      if (warning.error.code !== "generation_outcome_unknown"
        || warning.storyId === null) continue;
      if (!state.unknownOutcomes.some(
        ({ mutationId }) => mutationId === warning.mutationId
      )) {
        state.unknownOutcomes.push({
          storyId: warning.storyId,
          mutationId: warning.mutationId,
          method: warning.method
        });
      }
    }
    while (!stopped) {
      if (state.stream !== null || state.abort !== null || state.summary !== null
        || state.connection.down) {
        await retryDelay();
        continue;
      }
      let adopted = false;
      const started = await backend.run("recovering backend state", async (task) => {
        if (stopped || state.stream !== null || state.abort !== null || state.summary !== null) return;
        while (!stopped && task.owns() && task.storyCurrent() && !state.connection.down) {
          const outcome = await reconcileOwned(task, "warning");
          if (outcome === null) return;
          const disposition = settleOutcome(task, outcome);
          if (disposition === "superseded") continue;
          if (disposition === "stopped") return;
          if (outcome.kind === "failed") throw outcome.error;
          if (disposition === "offline") return;
          const result = outcome.result;
          if (warnings.length > 0 || result.interactionStable || result.changedStory) {
            state.toast = warnings.length === 0
              ? "startup recovery complete · state reloaded"
              : `${recoveryNotice(warnings)} · state reloaded`;
          }
          repaint();
          adopted = true;
          return;
        }
      }, { kind: "connection-reconcile", reportBusy: false });
      if (started && adopted) return;
      await retryDelay();
    }
  };

  const unsubscribeRecovery = source.backendRecovery?.subscribe(
    // RecoveryWarningFeed awaits this Promise before acknowledging warnings.
    (warnings) => refreshAfterRecovery(warnings),
    (error) => {
      if (stopped) return;
      state.toast = `recovery check failed · ${error instanceof Error ? error.message : String(error)}`;
      repaint();
    }
  ) ?? null;

  const ensureReconnectRefresh = () => {
    if (reconnectRefreshScheduled || stopped || state.connection.down
      || settledReconnectIntent >= reconnectIntent) return;
    reconnectRefreshScheduled = true;
    const runner = runReconnectRefresh();
    backend.observe(runner);
    void runner.then(releaseReconnectRunner, releaseReconnectRunner);
  };

  const runReconnectRefresh = async (): Promise<void> => {
    while (!stopped && !state.connection.down && settledReconnectIntent < reconnectIntent) {
      let refreshed = false;
      const started = await backend.run("reloading after reconnect", async (task) => {
        while (!stopped && task.owns() && task.storyCurrent() && !state.connection.down) {
          const outcome = await reconcileOwned(task, "automatic");
          if (outcome === null) return;
          const disposition = settleOutcome(task, outcome);
          if (disposition === "superseded") continue;
          if (disposition === "stopped") return;
          if (outcome.kind === "failed") throw outcome.error;
          if (disposition === "offline") return;
          if (outcome.result.interactionStable) state.toast = "reconnected · story reloaded";
          refreshed = true;
          return;
        }
      }, { kind: "connection-reconcile", reportBusy: false });
      if (!started) {
        await retryDelay();
        continue;
      }
      if (refreshed) continue;
      if (!stopped && !state.connection.down) await retryDelay();
    }
  };

  function releaseReconnectRunner(): void {
    reconnectRefreshScheduled = false;
    ensureReconnectRefresh();
  }

  const requestReconnectRefresh = (schedule: boolean): number => {
    reconnectIntent += 1;
    if (schedule) ensureReconnectRefresh();
    return reconnectIntent;
  };

  const unsubscribeConnection = source.connection?.subscribe((connection) => {
    const cameBackUp = state.connection.down && !connection.down;
    connectionEpoch += 1;
    state.connection = connection;
    // The first up transition emitted by an explicit probe belongs to its
    // typed coordinator request. Any later transition supersedes its snapshot
    // and is consumed by that same owner before it can release.
    const probeOwnsTransition = cameBackUp
      && explicitProbe !== null
      && state.backendTask?.id === explicitProbe.taskId
      && state.backendTask.kind === "explicit-retry"
      && !explicitProbe.handledTransition;
    if (probeOwnsTransition) explicitProbe!.handledTransition = true;
    else if (cameBackUp) requestReconnectRefresh(true);
    repaint();
  }) ?? null;

  const retry = async (): Promise<void> => {
    const connection = source.connection;
    if (connection === null || stopped) return;
    await backend.run("reconnecting", async (task) => {
      // An online health check emits no up transition. It must not reserve an
      // unrelated future recovery transition as if the explicit probe owned it.
      const probe: ExplicitProbe = {
        taskId: task.id,
        handledTransition: !connection.state().down
      };
      explicitProbe = probe;
      try {
        const connected = await connection.retryNow();
        if (!task.owns()) return;
        state.connection = connection.state();
        if (!connected) {
          if (task.interactionCurrent()) state.toast = "reconnect failed · retry scheduled";
          return;
        }
        requestReconnectRefresh(false);
        if (task.interactionCurrent()) {
          state.toast = "reconnected · refreshing state";
          repaint();
        }
        while (!stopped && task.owns() && task.storyCurrent() && !state.connection.down) {
          const outcome = await reconcileOwned(task, "explicit");
          if (outcome === null) return;
          const disposition = settleOutcome(task, outcome);
          if (disposition === "superseded") continue;
          if (disposition === "stopped") return;
          if (outcome.kind === "failed") throw outcome.error;
          if (disposition === "offline") return;
          if (task.interactionCurrent()) state.toast = "reconnected · story reloaded";
          return;
        }
      } finally {
        if (explicitProbe === probe) explicitProbe = null;
      }
    }, { kind: "explicit-retry" });
  };

  const stop = (() => {
    if (stopped) return;
    stopped = true;
    unsubscribeConnection?.();
    unsubscribeRecovery?.();
    if (activeOrchestrations.get(state) === stop) activeOrchestrations.delete(state);
  }) as RecoveryOrchestration;
  stop.retry = retry;
  activeOrchestrations.set(state, stop);
  return stop;
}

/** Explicit retry joins the app's coordinator. Render-once and isolated action
 * tests get a narrowly scoped coordinator rather than a second direct path. */
export async function retryBackendState(options: RecoveryOrchestrationOptions): Promise<void> {
  const active = activeOrchestrations.get(options.state);
  if (active !== undefined) return await active.retry();
  const transient = startRecoveryOrchestration(options);
  try {
    await transient.retry();
  } finally {
    transient();
  }
}

/** Build and atomically publish one authoritative backend snapshot. Every
 * caller must supply a coordinator lease; there is no unfenced fallback. */
async function reconcileCurrentBackendState(
  state: RuntimeState,
  source: Pick<RecoverySource, "api" | "demo" | "stories" | "settingsView" | "settings" | "backendRecovery">,
  task: ActionTask,
  lease: ReconciliationLease,
  invalidateCache: () => void
): Promise<ReconciliationResult | null> {
  if (!lease.current()) return null;
  const [stories, settingsView] = await Promise.all([
    source.api.listStories(),
    source.api.getSettings()
  ]);
  if (!lease.current()) return null;
  const snapshot = await loadReconciliationTarget(source, stories, settingsView, lease);
  if (snapshot === null || !lease.current()) return null;

  const changedStory = state.payload.id !== snapshot.payload.id;
  const interactionStable = task.interactionCurrent();
  // No await may split this commit: catalog, settings, and story are one
  // publication from the lease's authoritative epoch.
  publishStories(state, source, snapshot.stories);
  publishSettingsView(state, source, snapshot.settingsView);
  adoptReconciliationSnapshot(state, snapshot.payload);
  invalidateCache();
  return { changedStory, interactionStable, storyId: snapshot.payload.id };
}

/** Resolve the task's story when it survives, otherwise the newest survivor
 * (or a narrowly admitted fresh story for an empty recovered catalog). */
async function loadReconciliationTarget(
  source: Pick<RecoverySource, "api" | "backendRecovery">,
  stories: StorySummary[],
  settingsView: SettingsView,
  lease: ReconciliationLease
): Promise<ReconciliationSnapshot | null> {
  if (!lease.current()) return null;
  const targetId = stories.some((story) => story.id === lease.storyId)
    ? lease.storyId
    : [...stories].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id;
  const payload = targetId === undefined
    ? await (source.backendRecovery?.runAdoptionMutation(() => source.api.createStory())
      ?? source.api.createStory())
    : await source.api.loadStory(targetId);
  if (!lease.current()) return null;
  if (targetId !== undefined) return { payload, stories, settingsView };
  const refreshedStories = await source.api.listStories();
  if (!lease.current()) return null;
  return { payload, stories: refreshedStories, settingsView };
}

export function recoveryNotice(warnings: readonly WorkerRecoveryWarning[]): string {
  return warnings.map(({ method, resolution, error }) =>
    error.code === "generation_outcome_unknown"
      ? `acknowledge explicitly · ${method} ${resolution}: provider request may have been billed or completed`
      : `${method} ${resolution}: ${error.message}`
  ).join(" · ");
}

async function retryDelay(): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 100);
    timer.unref?.();
  });
}
