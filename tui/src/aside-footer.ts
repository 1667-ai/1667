/** Footer policy shared by the standalone and in-story Aside renderers. */
import {
  asideNotes,
  currentAsideTurns,
  isAsideV2,
  type AsideSessionSurfaceState,
  type AsideSurfaceState
} from "./aside-surface.js";

export function asideFooterHint(surface: AsideSurfaceState): string {
  if (isAsideV2(surface)) {
    if (surface.confirmDelete !== null) return "D confirms · esc keeps";
    if (surface.confirmReset !== null) {
      if (surface.confirmReset.turnIndex < 0) return "↵ confirms · esc keeps";
      return "⌫ confirms · esc keeps";
    }
    if (surface.busy) return "t Thoughts · esc stops · the composer waits";
    if (surface.useMenu !== null) return "↑↓ · Enter · Esc turns";
    if (surface.focus === "turns" || surface.focus === "notes") {
      const turns = currentAsideTurns(surface);
      const reset = surface.turnCursor < Math.max(0, turns.length - 1)
        ? "⌫ reset here" : "r retake";
      const hops = surface.anchors.length > 1
        ? " · [ ] hop asides · g go to this take" : "";
      return `↑↓ turn · ←→ session · n new · ↵ use · ${reset} · D delete · t Thoughts · tab ask · esc exit${hops}`;
    }
    return "↵ ask · ⇧↵ newline · tab turns · esc exit";
  }
  if (surface.confirmClear) return "Clear all Side Notes? Enter confirms · Esc cancels";
  if (surface.busy && surface.inflightQuestion === null) return "Clearing…";
  if (surface.busy) return "Esc stop · PageUp/PageDown scroll · Shift+Up/Down line scroll";
  if (surface.useMenu !== null) return "↑↓ · Enter · Esc notes";
  if (surface.focus === "notes") {
    return "Esc ask · Enter use · ↑↓ notes · Tab ask · PageUp/PageDown scroll";
  }
  const notesHint = asideNotes(surface).length > 0 ? " · Tab notes" : "";
  return `Esc write · /clear clear · Enter ask · Shift+Enter newline${notesHint} · PageUp/PageDown scroll`;
}

/** Number of standalone v2 footer rows painted below the history. */
export function asideV2FooterHeight(
  surface: AsideSessionSurfaceState,
  cols: number,
  toast?: string | null
): number {
  const turnsFocus = surface.focus === "turns" || surface.focus === "notes";
  if (!turnsFocus && !surface.busy) return 0;
  if (turnsFocus && toast !== undefined && toast !== null && toast.length > 0) return 1;
  return cols >= 100 || surface.busy || surface.confirmReset !== null
    || surface.confirmDelete !== null ? 1 : 2;
}
