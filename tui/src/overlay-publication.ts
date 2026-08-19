import type { GenerationSettings, StorySummary } from "../../shared/types.js";
import type { SettingsView } from "../../shared/settings-v2-types.js";
import { libraryRows } from "./library-model.js";
import type { RuntimeState } from "./state.js";
import { applyGenerationSettings } from "./runtime-settings.js";
import { activeSettingsEdit } from "./settings-edit-state.js";
import { reconcileSettingsOverlay } from "./settings-overlay-model.js";
import { autoSelectSettingsSubscriptionPlan } from "./settings-subscription-default.js";

interface StoryCatalogSource { stories: StorySummary[] }
interface SettingsViewSource {
  settings: GenerationSettings;
  settingsView: SettingsView;
  demo: boolean;
}

/** Publish a catalog refresh to the cache and whichever Library surface is
 * live now, preserving its selected story rather than its numeric row.
 * An authoritative catalog that omits the singular Placement guard's story
 * proves that story is gone: clear the guard. Single-story payloads and plain
 * navigation do not pass through this boundary. */
export function publishStories(
  state: RuntimeState,
  source: StoryCatalogSource,
  stories: StorySummary[]
): void {
  source.stories = stories;
  const guard = state.unresolvedPlacement;
  if (guard !== null && !stories.some(({ id }) => id === guard.storyId)) {
    state.unresolvedPlacement = null;
  }
  const overlay = state.library;
  if (overlay === null) return;
  const query = overlay.query;
  const selectedId = libraryRows(overlay.stories, query)[overlay.cursor]?.id ?? null;
  overlay.stories = stories;
  const promptTargetId = overlay.prompt?.kind === "filter"
    ? undefined
    : overlay.prompt?.targetId;
  if (promptTargetId !== undefined && !stories.some(({ id }) => id === promptTargetId)) {
    overlay.prompt = null;
  }
  const rows = libraryRows(stories, query);
  const preservedIndex = selectedId === null ? -1 : rows.findIndex((story) => story.id === selectedId);
  overlay.cursor = preservedIndex >= 0
    ? preservedIndex
    : Math.min(overlay.cursor, Math.max(0, rows.length - 1));
}

/** Publish the settings aggregate while keeping runtime generation pinned to
 * the active effective projection. Pending documents are status/editor data. */
export function publishSettingsView(
  state: RuntimeState,
  source: SettingsViewSource,
  view: SettingsView
): void {
  source.settingsView = view;
  applyGenerationSettings(state, source, view);
  const overlay = state.settings;
  if (overlay !== null) {
    const edit = activeSettingsEdit(state, overlay);
    const message = reconcileSettingsOverlay(
      overlay,
      view,
      edit
    );
    overlay.view = view;
    autoSelectSettingsSubscriptionPlan(overlay, edit);
    overlay.result = null;
    if (message !== null) state.toast = message;
  }
  if (overlay !== null && !view.editable) {
    state.toast = "legacy settings are read-only · draft kept";
  }
}
