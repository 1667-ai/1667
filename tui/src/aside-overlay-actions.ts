/** Aside-specific overlay dispatch and modal-layer policy. */
import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import {
  asideBodyHeight,
  asideComposerRows,
  clearAsideSurface,
  closeAside,
  noteAsideDisplayScroll,
  revealAsideFocusedNote,
  scrollAside,
  sendAsideQuestion,
  stopAsideAsk
} from "./aside-actions.js";
import {
  applyAsideUseMenu,
  closeAsideUseMenu,
  cycleAsideFocus,
  focusAsideUseMenuIndex,
  moveAsideNoteFocus,
  moveAsideUseMenuCursor,
  openAsideUseMenu
} from "./aside-use.js";
import { composerMotion } from "./composer-motion.js";
import { directComposerWrapWidth } from "./composer-geometry.js";
import { composerPageRows } from "./composer-viewport.js";
import { composerSurfaceAction } from "./composer-surface-action.js";
import { insertComposerText, setComposerText } from "./composer-model.js";
import { applyTextKey, type ResolvedKey } from "./keys.js";
import type { RuntimeState } from "./state.js";
import {
  asideCursor,
  claimAsideComposer,
  currentAsideTurns,
  disarmAsideConfirmation,
  isAsideV2,
  type AsideSurfaceState
} from "./aside-surface.js";
import { asideV2KeyAction } from "./aside-v2-actions.js";
import { blockFactConsistencyCheck } from "./fact-consistency-guard.js";

type AsideOverlayContext = ActionContext;

function asideViewportBodyRows(
  surface: AsideSurfaceState,
  context: AsideOverlayContext,
  toast?: string | null
): { width: number; bodyRows: number } {
  const width = context.renderer?.width ?? 80;
  const height = context.renderer?.height ?? 24;
  const composerRows = asideComposerRows(height);
  return {
    width,
    bodyRows: asideBodyHeight(surface, width, height, composerRows, toast)
  };
}

/** Handle the Aside overlay, including its nested use-menu and composer. */
export async function asideKeyAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: AsideOverlayContext
): Promise<void> {
  const surface = state.aside;
  if (surface === null) return;
  if (isAsideV2(surface) && await asideV2KeyAction(resolved, state, surface, {
      source,
      backend: context.backend,
      cache: context.cache,
      repaint: context.repaint,
      renderer: context.renderer,
      toast: state.toast
  })) return;
  if (resolved.action === "paste-clipboard") {
    if (!claimAsideComposer(surface)) return;
  }
  if (resolved.action === "cancel") {
    // A busy Aside owns Escape for cancellation. Check this before the
    // turns-to-composer focus transition, or a v2 retake loses its stop path.
    if (surface.busy) {
      // Clear has no abort path. Its missing in-flight question is the
      // existing distinction from an Ask, so Esc remains a no-op while it
      // commits instead of pretending to stop anything.
      if (surface.inflightQuestion !== null) {
        stopAsideAsk(state);
        context.repaint();
      }
      return;
    }
    if (surface.useMenu !== null) {
      closeAsideUseMenu(surface);
      return;
    }
    if (surface.focus === "notes" || surface.focus === "turns") {
      if (isAsideV2(surface)) {
        closeAside(state);
        return;
      }
      surface.focus = "composer";
      return;
    }
    if (isAsideV2(surface) && currentAsideTurns(surface).length > 0) {
      // Match story mode: close the prompt layer before leaving its parent.
      // The draft remains available when the writer opens the prompt again.
      surface.focus = "turns";
      return;
    }
    if (isAsideV2(surface)) {
      if (surface.confirmReset !== null) {
        surface.confirmReset = null;
        return;
      }
    } else if (surface.confirmClear) {
      surface.confirmClear = false;
      return;
    }
    // Esc when idle returns to Write.
    closeAside(state);
    return;
  }
  if (surface.useMenu !== null) {
    if (resolved.action === "focus-next") {
      moveAsideUseMenuCursor(surface, 1);
      return;
    }
    if (resolved.action === "focus-previous") {
      moveAsideUseMenuCursor(surface, -1);
      return;
    }
    if (resolved.action === "focus-index") {
      focusAsideUseMenuIndex(surface, resolved.index ?? surface.useMenu.cursor);
      return;
    }
    if (resolved.action === "apply" || resolved.action === "open-selected") {
      if (resolved.index !== undefined) {
        focusAsideUseMenuIndex(surface, resolved.index);
      }
      await applyAsideUseMenu(state);
      return;
    }
    // Use menu owns the surface: scrim/cancel stay authoritative; compose does
    // not steal focus from under the modal.
    return;
  }

  if (resolved.action === "cycle") {
    if (cycleAsideFocus(surface)
      && (surface.focus === "notes" || surface.focus === "turns")) {
      const { width, bodyRows } = asideViewportBodyRows(surface, context, state.toast);
      revealAsideFocusedNote(surface, width, bodyRows);
    }
    return;
  }
  if (resolved.action === "scroll-line-down" || resolved.action === "scroll-line-up"
    || resolved.action === "scroll-down" || resolved.action === "scroll-up") {
    const width = context.renderer?.width ?? 80;
    const height = context.renderer?.height ?? 24;
    const composerRows = asideComposerRows(height);
    const page = asideBodyHeight(surface, width, height, composerRows, state.toast);
    const delta = resolved.action === "scroll-line-down" || resolved.action === "scroll-down"
      ? resolved.action === "scroll-down" ? page : 1
      : resolved.action === "scroll-up" ? -page : -1;
    scrollAside(surface, delta, width, height, composerRows, state.toast);
    if (surface.busy) noteAsideDisplayScroll(state);
    return;
  }
  if (surface.focus === "notes" || surface.focus === "turns") {
    // Left-click on the visible prompt claims composer focus so paste/text
    // target it. Use menu already returned above.
    if (resolved.action === "compose") {
      claimAsideComposer(surface);
      return;
    }
    if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
      moveAsideNoteFocus(surface, resolved.action === "focus-next" ? 1 : -1);
      const { width, bodyRows } = asideViewportBodyRows(surface, context, state.toast);
      revealAsideFocusedNote(surface, width, bodyRows);
      return;
    }
    if (resolved.action === "open-selected" || resolved.action === "apply") {
      // Re-anchor under the current terminal size: a stale scrollTop from a
      // prior width/header layout can hide noteCursor while Enter still uses it.
      const { width, bodyRows } = asideViewportBodyRows(surface, context, state.toast);
      revealAsideFocusedNote(surface, width, bodyRows);
      openAsideUseMenu(surface, asideCursor(surface));
      return;
    }
    return;
  }
  const width = context.renderer?.width ?? 80;
  const height = context.renderer?.height ?? 24;
  const motion = composerMotion(true, () => directComposerWrapWidth(width, state.config, true));
  if (resolved.action === "cursor-up" || resolved.action === "cursor-down") {
    motion.vertical(
      surface.composer,
      resolved.action === "cursor-up" ? -1 : 1,
      resolved.extendSelection
    );
    return;
  }
  if (resolved.action === "send") {
    if (surface.composer.text.trim() !== "/clear" && blockFactConsistencyCheck(state)) return;
    if (surface.busy) return;
    if (!isAsideV2(surface) && surface.confirmClear) {
      context.backend.observe(context.backend.run("clearing Aside", (task) =>
        clearAsideSurface(state, source.api, context.cache, { task })
      ));
      return;
    }
    const text = surface.composer.text;
    if (text.trim() === "/clear") {
      setComposerText(surface.composer, "");
      if (!isAsideV2(surface)) surface.confirmClear = true;
      return;
    }
    context.backend.observe(context.backend.run("asking Aside", async (task) => {
      await sendAsideQuestion(state, source.api, text, {
        task,
        repaint: context.repaint,
        cache: context.cache
      });
    }));
    return;
  }
  if (resolved.action === "newline") {
    disarmAsideConfirmation(surface);
    insertComposerText(surface.composer, "\n");
    return;
  }
  if (resolved.action === "input" && resolved.text !== undefined) {
    disarmAsideConfirmation(surface);
    insertComposerText(surface.composer, resolved.text);
    return;
  }
  if (await composerSurfaceAction(resolved, state, surface.composer, {
    isCurrent: () => state.mode === "ASIDE" && state.aside === surface,
    pageRows: composerPageRows(height, true),
    motion,
    onEdit: (kind) => {
      if (kind !== "move") disarmAsideConfirmation(surface);
    }
  })) return;
  // Keep the fallback for plain text actions that do not belong to the shared
  // composer reducer. All structural edits above preserve cursor state.
  const next = applyTextKey(surface.composer.text, resolved);
  if (next !== null) {
    disarmAsideConfirmation(surface);
    setComposerText(surface.composer, next);
  }
}
