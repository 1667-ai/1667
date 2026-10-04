import type { KeyboardEvent } from "react";
import type { ContentActions } from "../app/content-actions.js";

/**
 * The Aside view's keys, for `StoryPanel`'s keyboard: ↑↓ pick a turn, ←→ change
 * session, `r` retakes the last answer, `R` retakes it with an edited
 * question, `D` deletes the turn, Backspace resets to it, `n` starts a
 * session, `[` and `]` go to the next anchor with sessions, `g` goes to the
 * take, Enter opens the Use menu of the turn, `i` goes to the question box, Esc stops a running answer or closes.
 * The question box and the confirm dialog handle their own keys.
 */
export function handleAsideKey(
  event: KeyboardEvent<HTMLElement>,
  context: { readonly actions: ContentActions; readonly close: () => void }
): void {
  const { actions, close } = context;
  if (event.defaultPrevented || event.nativeEvent.isComposing) return;
  const target = event.target as HTMLElement;
  if (target.closest("dialog") !== null) return;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const handled = (): void => event.preventDefault();
  // A held key must not repeat an action; only the arrows repeat.
  if (event.repeat && event.key !== "ArrowUp" && event.key !== "ArrowDown") {
    handled();
    return;
  }
  const aside = actions.aside;
  switch (event.key) {
    case "Escape":
      handled();
      if (!aside.stop()) close();
      return;
    case "ArrowDown": handled(); aside.moveTurn(1); return;
    case "ArrowUp": handled(); aside.moveTurn(-1); return;
    case "ArrowRight": handled(); aside.cycleSession(1); return;
    case "ArrowLeft": handled(); aside.cycleSession(-1); return;
    case "Enter":
      // A focused button gives Enter its own meaning.
      if (target instanceof HTMLButtonElement) return;
      handled();
      event.currentTarget.querySelector<HTMLButtonElement>(".aside-use-trigger")?.click();
      return;
    case "r": handled(); void aside.retake(); return;
    case "R": handled(); aside.startRetake(); return;
    case "D": handled(); aside.requestConfirm("delete"); return;
    case "Backspace": handled(); aside.requestConfirm("reset"); return;
    case "n": handled(); aside.newSession(); return;
    case "[": handled(); aside.hopBy(-1); return;
    case "]": handled(); aside.hopBy(1); return;
    case "g": handled(); aside.goToAnchor(); return;
    case "i":
      handled();
      event.currentTarget.querySelector("textarea")?.focus();
      return;
    default:
  }
}
