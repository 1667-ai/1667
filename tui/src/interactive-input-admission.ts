/**
 * Interactive click and text admission. One owner for multi-event gate
 * lifecycle, keyboard/paste interruption, and presented-frame mouse capture.
 * runInteractive and integration tests share this boundary.
 */
import type { MouseEvent } from "@opentui/core";
import {
  createClickGestureController,
  createFactDoubleClickGate,
  createSelectionSafeMouseGate,
  mouseToAction,
  withInterruptedClickGestures,
  type ClickGestureController,
  type MouseGesture
} from "./mouse-actions.js";
import type { PresentedInputQueue } from "./presented-input-queue.js";
import {
  canCapturePresentedMouseAction,
  freezeMouseEvent,
  type FrozenMouseEvent,
  type PresentedInteraction
} from "./presented-mouse-action.js";
import type { ResolvedKey } from "./keys.js";

export interface InteractiveInputAdmission {
  readonly clickGestures: ClickGestureController;
  /** Clear pending multi-event pairs (frame loss, ownership change, error). */
  reset(): void;
  /** Enqueue keyboard/paste after interrupting incomplete click pairs. */
  enqueueText(
    queue: PresentedInputQueue,
    run: () => void | Promise<void>,
    onPresentationFailure?: () => void
  ): void;
  /**
   * Gate a mouse gesture against the presented frame and enqueue its runner.
   * Returns true when a resolved action was queued.
   */
  enqueueMouse(
    queue: PresentedInputQueue,
    event: MouseGesture,
    options: {
      presented: PresentedInteraction | null;
      frameFailed: boolean;
      requestInputRecovery(): void;
      /** Still-presented check after gate resolve (drop if ownership moved). */
      stillPresented?(captured: PresentedInteraction): boolean;
      decorate?(
        resolved: ResolvedKey | null,
        event: MouseGesture,
        presented: PresentedInteraction
      ): ResolvedKey | null;
      run(
        action: ResolvedKey,
        event: FrozenMouseEvent,
        captured: PresentedInteraction
      ): void | Promise<void>;
    }
  ): boolean;
}

export function createInteractiveInputAdmission(
  options: { now?: () => number } = {}
): InteractiveInputAdmission {
  const selectionGate = createSelectionSafeMouseGate();
  const factGate = createFactDoubleClickGate(options.now);
  const clickGestures = createClickGestureController([selectionGate, factGate]);
  return {
    clickGestures,
    reset() {
      clickGestures.reset();
    },
    enqueueText(queue, run, onPresentationFailure) {
      queue.enqueue(
        withInterruptedClickGestures(clickGestures, run),
        onPresentationFailure
      );
    },
    enqueueMouse(queue, event, options) {
      const presented = options.presented;
      if (!canCapturePresentedMouseAction(presented, options.frameFailed)) {
        clickGestures.reset();
        options.requestInputRecovery();
        return false;
      }
      let resolved = selectionGate.resolve(
        event,
        mouseToAction(event, presented.state, event.type === "up")
      );
      resolved = factGate.resolve(event, resolved, presented.state);
      if (options.decorate !== undefined) {
        resolved = options.decorate(resolved, event, presented);
      }
      if (resolved === null) return false;
      if (options.stillPresented?.(presented) === false) return false;
      const action = resolved;
      const queuedEvent = freezeMouseEvent(event as MouseEvent);
      const captured = presented;
      queue.enqueue(() => options.run(action, queuedEvent, captured));
      return true;
    }
  };
}
