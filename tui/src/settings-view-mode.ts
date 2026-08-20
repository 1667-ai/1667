import type {
  SettingsDocumentV2,
  SettingsViewModeV2
} from "../../shared/settings-v2-types.js";
import type { SettingsOverlayState, SettingsRowId } from "./state.js";

export const DEFAULT_SETTINGS_VIEW_MODE: SettingsViewModeV2 = "simple";

/** Rows `simple` mode shows on every overlay. `base-url` and `api-key` are
 *  listed here too, but the subscription visibility filter
 *  (settings-subscription.ts) still owns whether they actually render: a
 *  fixed subscription connection hides them in both modes, one visibility
 *  rule instead of two that could drift apart. */
const SETTINGS_SIMPLE_ROW_IDS: ReadonlySet<SettingsRowId> = new Set([
  "system-prompt",
  "provider",
  "model",
  "context-window",
  "base-url",
  "api-key"
]);

/** The overlay's current view mode. This is session state, not derived from
 *  the draft document: which rows show is a view concern that must work even
 *  for a read-only legacy view with no document, while `initialSettingsOverlay`
 *  still seeds it from the document's `settingsViewMode` (absence means
 *  `simple`) so a saved choice reopens as it was left. */
export function settingsViewMode(overlay: SettingsOverlayState): SettingsViewModeV2 {
  return overlay.viewMode;
}

export function settingsSimpleModeRowVisible(row: SettingsRowId): boolean {
  return SETTINGS_SIMPLE_ROW_IDS.has(row);
}

/** Flip simple/advanced for the rest of the session, and — when a document
 *  exists — mirror the choice onto the draft document, the same field the
 *  save pipeline round-trips, so `s` persists it. A read-only legacy view has
 *  nothing to persist into, so the flip there is session-only; everything
 *  else on that surface is already view-only in the same way.
 *
 *  The document patch stays a plain field replacement rather than routing
 *  through settingsTextDraftForDocument: that helper reprojects `generation`
 *  from the document, which would silently drop a live edit the draft
 *  carries that the document does not yet reflect (an in-progress row, or a
 *  value set directly on the draft ahead of a save). This field has no
 *  relationship to generation, so a patch is all it needs.
 *
 *  Cursor placement after a flip is the caller's job: this module stays free
 *  of settings-row-navigation.ts's cursor helpers so nothing here has to
 *  import back the module that imports this one for row filtering. */
export function toggleSettingsViewMode(
  overlay: SettingsOverlayState
): SettingsViewModeV2 {
  const next: SettingsViewModeV2 = overlay.viewMode === "simple" ? "advanced" : "simple";
  overlay.viewMode = next;
  const document = overlay.draft.document;
  if (document !== null) {
    overlay.draft = { ...overlay.draft, document: withSettingsViewMode(document, next) };
  }
  return next;
}

function withSettingsViewMode(
  document: SettingsDocumentV2,
  mode: SettingsViewModeV2
): SettingsDocumentV2 {
  if (mode === DEFAULT_SETTINGS_VIEW_MODE) {
    const { settingsViewMode: _mode, ...rest } = document;
    return rest;
  }
  return { ...document, settingsViewMode: mode };
}
