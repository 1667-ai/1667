import type { AppMode } from "./keys.js";

export interface PresentedInputQueue {
  enqueue(input: () => void | Promise<void>, onPresentationFailure?: () => void): void;
  presented(): void;
  presentationFailed(): void;
  shouldQuitImmediately(mode: AppMode, frameFailed: boolean): boolean;
  readonly pending: number;
}

/** Preserve input order across application/native frame handoff. Each input
 * gets a chance to flush a recoverable build, but runs only when its state is
 * represented by the latest complete native presentation. */
export function createPresentedInputQueue(options: {
  flush(): void;
  ready(): boolean;
  recoveryExhausted?(): boolean;
}): PresentedInputQueue {
  const pending: Array<{
    run: () => void | Promise<void>;
    onPresentationFailure?: () => void;
  }> = [];
  let draining = false;
  let admitting = false;
  const reject = (input: (typeof pending)[number]) => {
    try { input.onPresentationFailure?.(); } catch {
      /* one emergency escape cannot suppress later input */
    }
  };

  const drain = () => {
    if (draining || admitting) return;
    draining = true;
    try {
      while (pending.length > 0) {
        options.flush();
        if (!options.ready()) break;
        const admission = pending.shift();
        if (admission === undefined) break;
        const result = admission.run();
        if (result !== undefined) {
          admitting = true;
          void result.then(
            () => { admitting = false; drain(); },
            () => { admitting = false; drain(); }
          );
          break;
        }
        if (!options.ready()) break;
      }
    } finally {
      draining = false;
    }
  };

  return {
    enqueue(input, onPresentationFailure) {
      const admission = { run: input, onPresentationFailure };
      if (options.recoveryExhausted?.() === true) {
        reject(admission);
        return;
      }
      pending.push(admission);
      drain();
    },
    presented: drain,
    presentationFailed() {
      const unsafe = pending.splice(0);
      for (const input of unsafe) reject(input);
    },
    shouldQuitImmediately(mode, frameFailed) {
      return frameFailed || pending.length === 0 && !admitting && mode !== "EDITOR";
    },
    get pending() { return pending.length + (admitting ? 1 : 0); }
  };
}

/** Resolve when an async reducer is admitted: explicit repaint/backend claim,
 * or settlement for a no-op/error. Long backend work is observed separately. */
export function observeInputAdmission(
  start: (admit: () => void) => Promise<unknown>,
  observe: (work: Promise<unknown>) => void
): Promise<void> {
  let admitted = false;
  let resolveAdmission!: () => void;
  const admission = new Promise<void>((resolve) => { resolveAdmission = resolve; });
  const admit = () => {
    if (admitted) return;
    admitted = true;
    resolveAdmission();
  };
  const work = start(admit);
  void work.then(admit, admit);
  observe(work);
  return admission;
}
