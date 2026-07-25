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

export interface ActionRunner {
  run(label: string, work: ActionWork, options?: ActionRunOptions): Promise<boolean>;
  observe(work: Promise<unknown>): void;
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
export class ActionRuntime implements ActionRunner {
  private ownedId: number | null = null;
  private disposed = false;

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
      if (this.state.toast === `busy · ${label} still running`) this.state.toast = null;
      if (!this.disposed) this.repaint();
    }
  }

  observe(work: Promise<unknown>): void {
    void work.catch((error: unknown) => {
      if (this.disposed) return;
      this.state.toast = error instanceof Error ? error.message : String(error);
      this.repaint();
    });
  }

  dispose(): void {
    this.disposed = true;
    const ownedId = this.ownedId;
    this.ownedId = null;
    if (ownedId !== null && this.state.backendTask?.id === ownedId) this.state.backendTask = null;
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
    observe: (work) => backend.observe(work)
  };
}

/** One interaction epoch per keyboard, mouse, or paste reducer. */
export function beginInteraction(state: RuntimeState): void {
  state.interactionVersion += 1;
}
