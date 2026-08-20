import type { BackendTaskKind, RuntimeState } from "./state.js";

export interface ActionTask {
  readonly id: number;
  readonly label: string;
  readonly storyId: string;
  owns(): boolean;
  storyCurrent(): boolean;
  interactionCurrent(): boolean;
}

export type ActionWork = (task: ActionTask) => Promise<void>;
export interface ActionRunOptions {
  kind?: BackendTaskKind;
  reportBusy?: boolean;
}

/** Work admitted through `runWhenIdle` (below). `isCurrent()` plays the
 * role `ActionTask.owns()` plays for `run` — a late response applies only
 * if it is still true — except it is backed by `runWhenIdle`'s own lane
 * ownership, not the exclusive slot, because this work never claims that
 * slot at all. */
export type BackgroundWork = (isCurrent: () => boolean) => Promise<void>;

export interface ActionRunner {
  run(label: string, work: ActionWork, options?: ActionRunOptions): Promise<boolean>;
  whenIdle(): Promise<boolean>;
  observe(work: Promise<unknown>): void;
  /** Run `work` once the exclusive slot is free, without ever claiming it —
   * a caller here has explicitly opted out of foreground priority, so an
   * explicit action (`run`) always outranks it and can never be rejected
   * as busy on its account. `key` names a lane: a second request for the
   * same key replaces whatever that lane is currently doing (waiting, or
   * already running `work`) instead of starting a second concurrent
   * attempt — the lane always ends up serving the most recent request, at
   * the cost of at most one attempt already committed to a superseded one.
   * `stillWanted` is re-checked immediately before `work` starts, so a
   * request that became moot while it waited (busy, or behind another
   * request for the same key) is dropped instead of running stale.
   * `debounceMs` (default 0) delays the first attempt for a fresh lane;
   * a second request for the same key arriving before that delay elapses
   * restarts it — the same trailing-edge coalescing search-request.ts's
   * `runSearch` already does for typing, applied here to any caller that
   * wants a burst of triggers to settle into one attempt rather than one
   * per trigger. A request that arrives after the delay has elapsed (the
   * lane is already waiting on the slot or running `work`) does not reset
   * anything — it just supersedes, as above. */
  runWhenIdle(
    key: string,
    work: BackgroundWork,
    stillWanted: () => boolean,
    debounceMs?: number
  ): void;
}

let nextTaskId = 1;

/**
 * Owns the one backend action admitted by the current TUI protocol.
 *
 * Unary StoryApi calls do not yet expose a terminal-status fence, so an
 * unsettled call keeps this owner. Conflicting work is rejected immediately;
 * it is never hidden in another Promise queue. Control and local reducers do
 * not use this runtime and therefore remain responsive.
 */
interface WhenIdleLane {
  work: BackgroundWork;
  stillWanted: () => boolean;
  /** Bumped by every `runWhenIdle` call for this key, including the one
   * that created the lane. A driver captures the generation it started
   * `work` under; if it differs once `work` settles, a newer request
   * arrived while `work` was running, and the driver serves it next
   * instead of exiting — the same request, re-read live, not a second
   * concurrent one. */
  generation: number;
  /** Non-null while this lane is still waiting out its debounce delay —
   * a new request for the same key clears and restarts this timer instead
   * of just bumping `generation`. Null once the delay has elapsed (the
   * lane has moved on to waiting for the slot, or is running `work`), at
   * which point a new request only supersedes. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Resolves the debounce-wait promise `driveWhenIdleLane` is parked on;
   * set only while `timer` is non-null. */
  wake?: () => void;
}

export class ActionRuntime implements ActionRunner {
  private ownedId: number | null = null;
  private disposed = false;
  private readonly idleWaiters = new Set<(available: boolean) => void>();
  private readonly whenIdleLanes = new Map<string, WhenIdleLane>();
  private whenIdleLaneGeneration = 0;
  /** Every `runWhenIdle` driver currently alive (waiting or running `work`),
   * tracked only so test code can await full settlement — see `settle()`. */
  private readonly background = new Set<Promise<void>>();

  constructor(
    private readonly state: RuntimeState,
    private readonly repaint: () => void
  ) {}

  async run(label: string, work: ActionWork, options: ActionRunOptions = {}): Promise<boolean> {
    if (this.disposed) return false;
    if (this.state.backendTask !== null) {
      if (options.reportBusy !== false) {
        this.state.toast = `busy · ${this.state.backendTask.label} still running`;
        this.repaint();
      }
      return false;
    }

    const id = nextTaskId++;
    const storyId = this.state.payload.id;
    const interactionVersion = this.state.interactionVersion;
    this.ownedId = id;
    this.state.backendTask = { id, kind: options.kind ?? "action", label, storyId };
    const task: ActionTask = {
      id,
      label,
      storyId,
      owns: () => !this.disposed && this.ownedId === id && this.state.backendTask?.id === id,
      storyCurrent: () => !this.disposed && this.ownedId === id
        && this.state.backendTask?.id === id && this.state.payload.id === storyId,
      interactionCurrent: () => !this.disposed && this.ownedId === id
        && this.state.backendTask?.id === id
        && this.state.payload.id === storyId
        && this.state.interactionVersion === interactionVersion
    };

    try {
      this.repaint();
      await work(task);
      return true;
    } finally {
      if (this.ownedId === id) this.ownedId = null;
      if (this.state.backendTask?.id === id) this.state.backendTask = null;
      if (this.state.backendTask === null) this.resolveIdleWaiters(true);
      if (this.state.toast === `busy · ${label} still running`) this.state.toast = null;
      if (!this.disposed) this.repaint();
    }
  }

  whenIdle(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.state.backendTask === null) return Promise.resolve(true);
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  observe(work: Promise<unknown>): void {
    void work.catch((error: unknown) => {
      if (this.disposed) return;
      this.state.toast = error instanceof Error ? error.message : String(error);
      this.repaint();
    });
  }

  runWhenIdle(
    key: string,
    work: BackgroundWork,
    stillWanted: () => boolean,
    debounceMs = 0
  ): void {
    if (this.disposed) return;
    const existing = this.whenIdleLanes.get(key);
    if (existing !== undefined) {
      // A lane is already alive for this key — still debouncing, waiting on
      // the exclusive slot, or already mid-`work`. Hand it the newest
      // request instead of starting a second one: N requests for the same
      // key settle into at most the one already committed to running plus
      // one that serves whatever is current once it finishes, never N
      // concurrent attempts.
      existing.work = work;
      existing.stillWanted = stillWanted;
      existing.generation = ++this.whenIdleLaneGeneration;
      if (existing.timer !== null) {
        // Still inside the debounce window: restart it, the same
        // trailing-edge behavior search-request.ts's runSearch already
        // gives typing — a burst of requests keeps pushing the actual
        // attempt back instead of each one queuing its own.
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => this.wakeWhenIdleLane(existing), debounceMs);
      }
      return;
    }
    const lane: WhenIdleLane = {
      work,
      stillWanted,
      generation: ++this.whenIdleLaneGeneration,
      timer: null
    };
    this.whenIdleLanes.set(key, lane);
    const driver = this.driveWhenIdleLane(key, lane, debounceMs);
    this.background.add(driver);
    void driver.finally(() => this.background.delete(driver));
  }

  private wakeWhenIdleLane(lane: WhenIdleLane): void {
    lane.timer = null;
    lane.wake?.();
  }

  private async driveWhenIdleLane(
    key: string,
    lane: WhenIdleLane,
    debounceMs: number
  ): Promise<void> {
    try {
      if (debounceMs > 0) {
        await new Promise<void>((resolve) => {
          lane.wake = resolve;
          lane.timer = setTimeout(() => this.wakeWhenIdleLane(lane), debounceMs);
        });
        if (this.disposed || this.whenIdleLanes.get(key) !== lane) return;
      }
      for (;;) {
        if (this.disposed) return;
        if (this.state.backendTask !== null) {
          if (!await this.whenIdle()) return; // disposed while waiting
          continue; // re-check disposal/busy from the top
        }
        if (!lane.stillWanted()) return;
        const startedGeneration = lane.generation;
        const isCurrent = () => !this.disposed
          && this.whenIdleLanes.get(key) === lane
          && lane.generation === startedGeneration;
        try {
          await lane.work(isCurrent);
        } catch (error) {
          if (isCurrent()) {
            this.state.toast = error instanceof Error ? error.message : String(error);
            this.repaint();
          }
        }
        // A newer request superseded this one while `work` ran: serve it
        // (re-reading live state, not the stale closure) instead of
        // exiting. Nothing superseded it: this lane is spent.
        if (this.disposed || lane.generation === startedGeneration) return;
      }
    } finally {
      if (lane.timer !== null) clearTimeout(lane.timer);
      if (this.whenIdleLanes.get(key) === lane) this.whenIdleLanes.delete(key);
    }
  }

  /** Test-only: resolve once nothing is running under the exclusive slot
   * and every `runWhenIdle` driver this runtime is tracking has settled.
   * Production code has no reason to call this — the entire point of
   * `runWhenIdle` is that nothing else has to wait for it. */
  async settle(): Promise<void> {
    for (;;) {
      const outstanding = [...this.background];
      const busy = this.state.backendTask !== null;
      if (outstanding.length === 0 && !busy) return;
      await Promise.allSettled(busy ? [...outstanding, this.whenIdle()] : outstanding);
    }
  }

  dispose(): void {
    this.disposed = true;
    const ownedId = this.ownedId;
    this.ownedId = null;
    if (ownedId !== null && this.state.backendTask?.id === ownedId) this.state.backendTask = null;
    for (const lane of this.whenIdleLanes.values()) {
      if (lane.timer !== null) clearTimeout(lane.timer);
    }
    this.whenIdleLanes.clear();
    this.resolveIdleWaiters(false);
  }

  private resolveIdleWaiters(available: boolean): void {
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    waiters.forEach((resolve) => resolve(available));
  }
}

/** Mark input admission immediately before the shared runtime synchronously
 * claims or refuses backend ownership; settlement remains fully concurrent. */
export function withActionAdmission(
  backend: ActionRunner,
  admit: () => void
): ActionRunner {
  return {
    run(label, work, options) {
      admit();
      return backend.run(label, work, options);
    },
    whenIdle: () => backend.whenIdle(),
    observe: (work) => backend.observe(work),
    runWhenIdle: (key, work, stillWanted, debounceMs) =>
      backend.runWhenIdle(key, work, stillWanted, debounceMs)
  };
}

/** One interaction epoch per keyboard, mouse, or paste reducer. */
export function beginInteraction(state: RuntimeState): void {
  state.interactionVersion += 1;
}
