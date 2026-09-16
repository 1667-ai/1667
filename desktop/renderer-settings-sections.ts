/** Settings 2c's shell (DESIGN_SPEC.md §6): the left `nav.settings-sections`,
 * the D-07 pending bar, and the two sections (Desktop, Story tools) that read
 * top-level `RendererState`/`RendererActions` rather than the settings draft
 * alone. `renderer-settings-view.ts` holds the six document-only sections. */
import type { SettingsActivationOutcomeV2 } from "../shared/settings-v2-types.js";
import { DESKTOP_THEMES, type DesktopTheme, type RendererActions, type RendererState } from "./renderer-model.js";
import { el } from "./renderer-dom.js";
import { button as controlButton, scalar } from "./renderer-controls.js";
import {
  button,
  type SettingsEditorActions,
  type SettingsEditorProps
} from "./renderer-settings-controls.js";
import { SETTINGS_SECTION_IDS, type SettingsSectionId } from "./renderer-settings-model.js";
import { describeSettingsChanges } from "./renderer-settings-diff.js";
import {
  renderConnectionsSection,
  renderOutputReasoningSection,
  renderProfilesSection,
  renderRoutesSection,
  renderSamplingSection,
  renderWritingPromptsSection,
  section
} from "./renderer-settings-view.js";

const SECTION_LABELS: Readonly<Record<SettingsSectionId, string>> = {
  routes: "Routes",
  profiles: "Profiles",
  connections: "Connections",
  sampling: "Sampling",
  output: "Output & reasoning",
  writing: "Writing prompts",
  "story-tools": "Story tools",
  desktop: "Desktop"
};

function sectionCount(id: SettingsSectionId, props: SettingsEditorProps): number | null {
  if (id === "profiles") return Object.keys(props.document.profiles).length;
  if (id === "connections") return Object.keys(props.document.connections).length;
  return null;
}

function renderSettingsNav(active: SettingsSectionId, props: SettingsEditorProps, onSelect: (id: SettingsSectionId) => void): HTMLElement {
  const nav = el("nav", "settings-sections");
  nav.setAttribute("role", "listbox");
  nav.setAttribute("aria-label", "Settings sections");
  const items = SETTINGS_SECTION_IDS.map((id) => {
    const count = sectionCount(id, props);
    const item = document.createElement("button");
    item.type = "button";
    item.className = `settings-section-item${id === active ? " active" : ""}`;
    item.dataset.settingsSection = id;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(id === active));
    item.append(document.createTextNode(SECTION_LABELS[id]));
    if (count !== null) item.append(el("span", "settings-section-count", String(count)));
    item.addEventListener("click", () => onSelect(id));
    nav.append(item);
    return item;
  });
  nav.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (document.activeElement === null || !nav.contains(document.activeElement)) return;
    event.preventDefault();
    const index = SETTINGS_SECTION_IDS.indexOf(active);
    const nextIndex = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    onSelect(SETTINGS_SECTION_IDS[nextIndex]!);
    items[nextIndex]!.focus();
  });
  const pendingCount = describeSettingsChanges(props.activeDocument, props.draft).length;
  nav.append(el("p", "settings-revision-summary",
    [
      `active revision ${props.activeRevision}`,
      props.pendingRevision === null ? "" : `revision ${props.pendingRevision} waits to activate`,
      `${pendingCount} unapplied change${pendingCount === 1 ? "" : "s"}`
    ].filter((part) => part.length > 0).join(" · ")
  ));
  return nav;
}

function renderSettingsSheet(active: SettingsSectionId, state: RendererState, props: SettingsEditorProps, actions: SettingsEditorActions, rendererActions: RendererActions): HTMLElement {
  const content = active === "routes" ? renderRoutesSection(props, actions)
    : active === "profiles" ? renderProfilesSection(props, actions)
    : active === "connections" ? renderConnectionsSection(props, actions)
    : active === "sampling" ? renderSamplingSection(props, actions)
    : active === "output" ? renderOutputReasoningSection(props, actions)
    : active === "writing" ? renderWritingPromptsSection(props, actions)
    : active === "story-tools" ? renderStoryToolsSection(state, rendererActions)
    : renderDesktopSettingsSection(state, rendererActions);
  const sheet = el("div", "settings-sheet");
  sheet.dataset.settingsSection = active;
  sheet.append(content);
  return sheet;
}

function renderStoryToolsSection(state: RendererState, actions: RendererActions): HTMLElement {
  const story = state.story;
  const budgetField = story === null
    ? el("p", "empty-copy", "Open a story to set its Facts budget.")
    : renderFactsBudgetField(story.factsBudgetTokens, actions);
  return section("Story tools", "Apparatus that shapes what a story sends, kept with the story rather than a profile.",
    budgetField,
    el("div", "settings-story-tools-actions",
      button("story-phrase-bias", "Edit phrase bias", actions.editPhraseBias),
      button("story-banned-strings", "Edit banned strings", actions.editBannedStrings)
    )
  );
}

function renderFactsBudgetField(current: number | undefined, actions: RendererActions): HTMLElement {
  const wrapper = el("label", "settings-field", "Facts budget (tokens)");
  const control = scalar({
    value: current ?? null,
    min: 1,
    max: 1_000_000,
    step: 100,
    defaultValue: 2_000,
    id: "facts-budget",
    placeholder: "no limit",
    // The scalar commits on every keystroke/step; Facts budget keeps its
    // existing explicit "Save budget" step rather than saving as-you-type.
    onChange: () => undefined
  });
  const input = control.querySelector<HTMLInputElement>(".scalar-input")!;
  input.dataset.preserve = "facts-budget";
  input.setAttribute("aria-label", "Facts budget in tokens");
  const save = button("facts-budget-save", "Save budget", () => {
    const raw = input.value.trim();
    actions.setFactsBudget(raw.length === 0 ? null : Number(raw));
  });
  wrapper.append(control, save);
  return wrapper;
}

function renderDesktopSettingsSection(state: RendererState, actions: RendererActions): HTMLElement {
  const swatches = el("div", "theme-swatch-grid");
  for (const theme of DESKTOP_THEMES) swatches.append(renderThemeSwatch(theme, theme === state.theme, actions));
  const directions = document.createElement("button");
  directions.type = "button";
  directions.className = "button directions-toggle";
  directions.textContent = state.showDirections ? "directions on" : "directions off";
  directions.setAttribute("aria-pressed", String(state.showDirections));
  directions.title = state.showDirections ? "Hide part directions" : "Show part directions";
  directions.addEventListener("click", () => actions.setDirections(!state.showDirections));
  return section("Desktop", "Display only; this does not change story data.",
    swatches,
    el("label", "settings-field", "Directions", directions)
  );
}

function renderThemeSwatch(theme: DesktopTheme, active: boolean, actions: RendererActions): HTMLElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `theme-swatch${active ? " active" : ""}`;
  card.dataset.theme = theme;
  card.dataset.desktopTheme = theme;
  card.setAttribute("aria-pressed", String(active));
  card.append(
    el("span", "theme-swatch-name", theme),
    el("p", "theme-swatch-sample", "The lamp was low and the ink had not yet dried on the page.")
  );
  card.addEventListener("click", () => actions.setTheme(theme));
  return card;
}

export function renderSettingsDestination(state: RendererState, actions: RendererActions, props: SettingsEditorProps, settingsActions: SettingsEditorActions): HTMLElement {
  const active = state.settingsSection;
  const nav = renderSettingsNav(active, props, actions.setSettingsSection);
  const sheet = renderSettingsSheet(active, state, props, settingsActions, actions);
  const pendingBar = renderSettingsPendingBar(props, settingsActions);
  const shell = el("div", "settings-editor settings-editor-shell",
    nav,
    el("div", "settings-content", sheet, pendingBar)
  );
  if (props.busy !== null) {
    for (const control of shell.querySelectorAll("input, textarea, select, button")) {
      (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement).disabled = true;
    }
  }
  if (props.error !== null) shell.append(el("p", "settings-error settings-global-error", props.error));
  return shell;
}

function renderSettingsPendingBar(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const changes = describeSettingsChanges(props.activeDocument, props.draft);
  const invalidFieldCount = Object.keys(props.fieldErrors).length;
  const dirty = changes.length > 0;
  const saveLabel = props.pendingRevision !== null
    ? "Retry activation"
    : props.busy === "save"
      ? "Saving…"
      : dirty
        ? `Apply revision ${props.activeRevision + 1}`
        : "Save settings";
  const save = controlButton("primary", saveLabel, undefined, actions.save);
  save.classList.add("settings-save");
  save.disabled = props.busy !== null || invalidFieldCount > 0;
  const discardDraft = dirty ? controlButton("quiet", "Discard", undefined, actions.discardDraft) : "";
  if (typeof discardDraft !== "string") discardDraft.classList.add("settings-discard-draft");
  const discardPending = props.pendingRevision === null
    ? ""
    : button("settings-discard-pending", props.busy === "discard" ? "Discarding…" : "Discard pending", actions.discardPending);
  if (typeof discardPending !== "string") discardPending.disabled = props.busy !== null;
  const pendingNotice = props.pendingRevision === null ? "" : pendingSettingsNotice(props.lastActivationOutcome);
  const summary = dirty
    ? el("p", "settings-pending-summary", `${changes.length} change${changes.length === 1 ? "" : "s"} · ${changes.join(" · ")}`)
    : "";
  return el("div", "settings-pending-bar",
    summary,
    el("div", "settings-actions", save, button("settings-reload", "Reload", actions.reload), discardDraft, discardPending),
    pendingNotice,
    invalidFieldCount === 0
      ? ""
      : el("p", "settings-error settings-save-validation", `Fix ${invalidFieldCount} invalid field${invalidFieldCount === 1 ? "" : "s"} before saving.`)
  );
}

function pendingSettingsNotice(outcome: SettingsActivationOutcomeV2 | null): HTMLElement {
  const failure = activationFailureText(outcome);
  return el("div", "settings-pending-notice",
    el("strong", "", failure === null
      ? "Settings saved · not active yet."
      : `Settings saved · not active · ${failure}.`),
    el("p", "settings-help", failure === null
      ? "The saved candidate is pending. Retry activation checks it again. Discard pending removes it and keeps the active settings."
      : "Retry activation checks this saved candidate again. Discard pending removes it and keeps the active settings.")
  );
}

function activationFailureText(outcome: SettingsActivationOutcomeV2 | null): string | null {
  if (outcome === null || outcome.result === "committed") return null;
  switch (outcome.errorCode) {
    case "credential_unresolved":
      return "credential not found (env var or stored key)";
    case "candidate_invalid":
      return "provider check failed";
    case "activation_crashed":
      return "activation was interrupted";
    case "activation_failed":
    case "readiness_failed":
      return "rolled back after an interruption";
  }
}
