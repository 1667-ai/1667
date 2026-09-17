import type { StoryPayload } from "../shared/types.js";
import { estimateTokens } from "../shared/tokens.js";
import type { RendererActions, RendererState } from "./renderer-model.js";
import { renderLauncher } from "./renderer-launcher-view.js";
import { renderSettingsDestination } from "./renderer-settings-sections.js";
import { actionButton, el, focusPopoverCard, metricRow, panelHeading } from "./renderer-dom.js";
import { renderTitlebar, renderRail, renderFeedbackStack } from "./renderer-shell-view.js";
import { renderLibraryDestination } from "./renderer-library-view.js";
import { renderInspector } from "./renderer-inspector-view.js";
import { renderKeysSheet } from "./renderer-keys-view.js";
import { renderPalette } from "./renderer-palette-view.js";
import { renderWriting, renderPartMenu } from "./renderer-manuscript-view.js";
import { renderFacts } from "./renderer-facts-view.js";
import { renderChapters } from "./renderer-chapters-view.js";
import { renderMap } from "./renderer-map-view.js";
import { renderAsidePopover } from "./renderer-aside-popover-view.js";
import { renderLogPopover } from "./renderer-log-view.js";
import { renderComparePopover } from "./renderer-compare-view.js";

export function renderApp(root: HTMLElement, state: RendererState, actions: RendererActions): void {
  document.documentElement.dataset.desktopTheme = state.theme;
  if (state.project === null || !state.project.open || state.showProjects) {
    const hadDialog = root.querySelector(".modal-card") !== null;
    const launcher = renderLauncher(state, actions);
    const dialog = renderDialog(state, actions, !hadDialog);
    if (dialog !== null) launcher.append(dialog);
    root.replaceChildren(launcher);
    return;
  }
  const shell = el("div", `app-shell${state.inspectorHidden ? " inspector-hidden" : ""}`);
  const hadDialog = root.querySelector(".modal-card") !== null;
  const hadPopover = root.querySelector(".popover") !== null;
  shell.append(
    renderTitlebar(state, actions),
    renderRail(state, actions),
    renderWorkspace(state, actions),
    ...(state.inspectorHidden ? [] : [renderInspector(state, actions)])
  );
  if (state.popover?.kind === "keys") {
    const sheet = renderKeysSheet(actions);
    shell.append(sheet);
    if (!hadPopover) focusPopoverCard(sheet);
  }
  if (state.popover?.kind === "palette") shell.append(renderPalette(state, actions, !hadPopover));
  if (state.popover?.kind === "part-menu") {
    const menu = renderPartMenu(state, actions, state.popover.partId);
    if (menu !== null) {
      shell.append(menu);
      if (!hadPopover) focusPopoverCard(menu);
    }
  }
  if (state.popover?.kind === "aside") {
    const aside = renderAsidePopover(state, actions);
    shell.append(aside);
    if (!hadPopover) focusPopoverCard(aside);
  }
  if (state.popover?.kind === "log") {
    const log = renderLogPopover(state, actions);
    shell.append(log);
    if (!hadPopover) focusPopoverCard(log);
  }
  if (state.popover?.kind === "compare" && state.story !== null) {
    const compare = renderComparePopover(state.story, state, actions);
    if (compare !== null) {
      shell.append(compare);
      if (!hadPopover) focusPopoverCard(compare);
    }
  }
  const dialog = renderDialog(state, actions, !hadDialog);
  if (dialog !== null) shell.append(dialog);
  root.replaceChildren(shell);
}

function renderDialog(state: RendererState, actions: RendererActions, focusInitial: boolean): HTMLElement | null {
  const spec = state.dialog;
  if (spec === null) return null;
  const backdrop = el("div", "modal-backdrop");
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) actions.cancelDialog();
  });
  const form = document.createElement("form");
  form.className = `modal-card ${spec.kind === "form" ? "modal-form-card" : ""}`;
  form.setAttribute("aria-label", spec.title);
  form.setAttribute("role", "dialog");
  form.setAttribute("aria-modal", "true");
  const body = el("div", "modal-copy", el("span", "eyebrow", "Desktop"), el("h2", "", spec.title));
  if (spec.message !== undefined) body.append(el("p", "", spec.message));
  if (spec.kind === "text") {
    const input = spec.multiline ? document.createElement("textarea") : document.createElement("input");
    input.className = "modal-input";
    if (spec.multiline) {
      input.classList.add("modal-textarea");
      if (input instanceof HTMLTextAreaElement) input.rows = 7;
    }
    if (!spec.multiline && input instanceof HTMLInputElement && spec.secret === true) input.type = "password";
    input.value = spec.value;
    input.dataset.preserve = "dialog-value";
    input.autofocus = true;
    input.addEventListener("input", () => actions.setDialogValue(input.value));
    body.append(input);
  } else if (spec.kind === "choice") {
    const select = document.createElement("select");
    select.className = "modal-input";
    select.dataset.preserve = "dialog-value";
    for (const optionValue of spec.options ?? []) {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionValue || "No status";
      option.selected = optionValue === spec.value;
      select.append(option);
    }
    select.addEventListener("change", () => actions.setDialogValue(select.value));
    body.append(select);
  } else if (spec.kind === "form") {
    const fields = el("div", "modal-fields");
    for (const field of spec.fields ?? []) {
      const label = document.createElement("label");
      label.className = "modal-field";
      label.append(el("span", "modal-field-label", field.label));
      if (field.message !== undefined) label.append(el("span", "modal-field-message", field.message));
      const control = field.kind === "textarea"
        ? document.createElement("textarea")
        : field.kind === "choice"
          ? document.createElement("select")
          : document.createElement("input");
      control.className = "modal-input";
      control.dataset.preserve = `dialog-field:${field.id}`;
      control.dataset.dialogField = field.id;
      control.value = field.value;
      if (field.kind === "textarea" && control instanceof HTMLTextAreaElement) {
        control.rows = 4;
        control.classList.add("modal-textarea");
      }
      if (field.kind === "number" && control instanceof HTMLInputElement) control.type = "number";
      if (spec.secret === true && control instanceof HTMLInputElement) control.type = "password";
      if (field.kind === "choice" && control instanceof HTMLSelectElement) {
        for (const optionValue of field.options ?? []) {
          const option = document.createElement("option");
          option.value = optionValue;
          option.textContent = optionValue || "Default";
          option.selected = optionValue === field.value;
          control.append(option);
        }
      }
      control.addEventListener("input", () => actions.setDialogField(field.id, control.value));
      control.addEventListener("change", () => actions.setDialogField(field.id, control.value));
      label.append(control);
      fields.append(label);
    }
    body.append(fields);
  }
  const controls = el("div", "modal-controls");
  if (spec.kind !== "notice") controls.append(actionButton("modal-cancel", "Cancel", actions.cancelDialog));
  const submit = (): void => {
    if (spec.kind === "form") {
      actions.submitDialog(JSON.stringify(Object.fromEntries((spec.fields ?? []).map((field) => [field.id, field.value]))));
      return;
    }
    actions.submitDialog(spec.kind === "confirm" ? "confirm" : spec.value);
  };
  const submitButton = actionButton("modal-submit", spec.kind === "confirm" ? "Confirm" : spec.kind === "notice" ? "Close" : "Save", submit);
  controls.append(submitButton);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...form.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex=\"-1\"])")]
      .filter((element) => !(element as HTMLButtonElement).disabled && element.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  form.append(body, controls);
  backdrop.append(form);
  if (focusInitial) queueMicrotask(() => {
    if (spec.kind === "confirm" || spec.kind === "notice") submitButton.focus();
    else form.querySelector<HTMLElement>("[data-preserve]")?.focus();
  });
  return backdrop;
}

function renderWorkspace(state: RendererState, actions: RendererActions): HTMLElement {
  const main = el("main", "workspace");
  if (state.recoveryWarnings.length > 0) main.append(renderRecoveryWarnings(state, actions));
  const content = el("section", `tab-content ${state.tab}`);
  if (state.tab === "library") {
    content.append(renderLibraryDestination(state, actions));
  } else if (state.tab === "settings") {
    content.append(renderSettings(state, actions));
  } else if (state.story === null) {
    content.append(el("div", "welcome", el("span", "eyebrow", "No story open"), el("h1", "", "Make a place for the next sentence."), el("p", "", "Choose a story from the Library, or create one."), actionButton("welcome-create", "Create story", actions.createStory)));
  } else {
    const story = state.story;
    if (state.tab === "write") content.append(renderWriting(story, state, actions));
    if (state.tab === "facts") content.append(renderFacts(story, state, actions));
    if (state.tab === "chapters") content.append(renderChapters(story, state, actions));
    if (state.tab === "map") content.append(renderMap(story, state, actions));
    if (state.tab === "inspect") content.append(renderInspect(story, state, actions));
  }
  main.append(content, renderFeedbackStack(state));
  return main;
}

function renderRecoveryWarnings(state: RendererState, actions: RendererActions): HTMLElement {
  const card = el("section", "recovery-card", el("div", "panel-heading-copy", el("span", "eyebrow", "Recovery"), el("h2", "", "Review interrupted work."), el("p", "", "The Host kept an uncertain provider operation for review.")));
  const list = el("div", "recovery-list");
  for (const warning of state.recoveryWarnings) {
    const row = el("article", "recovery-row", el("strong", "", `${warning.method} · ${warning.resolution}`), el("p", "", warning.message));
    row.dataset.preserve = `recovery:${warning.mutationId}`;
    const button = actionButton("recovery-acknowledge", warning.storyId === null ? "Story unavailable" : "Acknowledge and reload", () => actions.acknowledgeRecovery(warning));
    button.disabled = warning.storyId === null;
    row.append(button);
    list.append(row);
  }
  card.append(list);
  return card;
}

function renderSettings(state: RendererState, actions: RendererActions): HTMLElement {
  const transfer = el("div", "settings-transfer-bar",
    actionButton("profile-import", "Import profile", () => { void importProfile(actions); }),
    actionButton("profile-export", "Export profile", () => { void exportProfile(actions, state.settingsEditor?.draft.selectedProfileId ?? null); })
  );
  if (state.settings === null) return el("div", "settings-editor-stack", transfer, el("div", "panel settings-panel", el("p", "empty-copy", "Loading settings…")));
  if (state.settingsEditor === null || state.settings.document === null) {
    return el("div", "settings-editor-stack", transfer, el("div", "panel settings-panel", el("p", "empty-copy", "This settings document is read-only in the current project.")));
  }
  const editor = state.settingsEditor;
  const props = {
    document: editor.draft.document,
    activeDocument: state.settings.document,
    draft: editor.draft,
    discovery: editor.discovery,
    busy: editor.busy,
    providerStatus: editor.providerStatus,
    error: editor.error,
    fieldErrors: editor.fieldErrors,
    pendingRevision: state.settings.pendingRevision,
    activeRevision: state.settings.activeRevision,
    lastActivationOutcome: state.settings.lastActivationOutcome
  };
  return el("div", "settings-editor-stack", transfer, renderSettingsDestination(state, actions, props, actions.settingsEditor));
}

function renderInspect(story: StoryPayload, state: RendererState, actions: RendererActions): HTMLElement {
  const panel = el("div", "panel");
  panel.append(panelHeading("Inspect the active line", "Read the request evidence behind any take without leaving the manuscript."));
  const list = el("div", "inspect-list");
  for (const node of story.path) {
    const card = el("article", "inspect-card");
    card.dataset.preserve = `inspect:${node.id}`;
    card.append(el("div", "inspect-card-title", `Part ${story.path.indexOf(node) + 1}: ${node.text.slice(0, 80) || "blank"}`));
    const request = document.createElement("details");
    request.className = "inspect-request";
    request.dataset.preserve = `inspect:request:${node.id}`;
    request.append(el("summary", "", "Request and context"), metricRow("direction", node.instruction.trim() || "default"), metricRow("words", node.text.split(/\s+/u).filter(Boolean).length.toLocaleString()), metricRow("tokens", `~${(estimateTokens(node.instruction) + estimateTokens(node.text)).toLocaleString()}`), metricRow("images", node.imageAttachments?.length === undefined ? "none" : String(node.imageAttachments.length)), metricRow("model", node.model || "provider default"));
    const controls = el("div", "inspect-controls");
    const thought = actionButton("inspect-reasoning", node.reasoning === true ? "Thought" : "No thought", () => actions.inspect("reasoning", node));
    thought.disabled = node.reasoning !== true;
    const probs = actionButton("inspect-probabilities", node.tokenProbabilities === true ? "Alternatives" : "No alternatives", () => actions.inspect("probabilities", node));
    probs.disabled = node.tokenProbabilities !== true;
    const records = actionButton("inspect-records", `${node.generationRecordCount ?? 0} records`, () => actions.inspect("records", node));
    records.disabled = (node.generationRecordCount ?? 0) === 0;
    controls.append(thought, probs, records);
    card.append(request, controls);
    list.append(card);
  }
  panel.append(list);
  if (state.inspector !== null) {
    const result = el("article", `inspector-result ${state.inspector.busy ? "busy" : ""}`, el("h3", "", state.inspector.title), el("pre", "", state.inspector.body || "Loading…"));
    panel.append(result);
  }
  return panel;
}

async function importProfile(actions: RendererActions): Promise<void> {
  const response = await actions.shellRequest({ type: "dialog.open", kind: "profile-import" });
  if (!response.ok || response.result.type !== "dialog" || response.result.paths[0] === undefined) return;
  await actions.shellRequest({ type: "profile.import", file: response.result.paths[0], profile: null });
}

async function exportProfile(actions: RendererActions, profile: string | null): Promise<void> {
  const response = await actions.shellRequest({ type: "dialog.directory" });
  if (!response.ok || response.result.type !== "dialog" || response.result.paths[0] === undefined) return;
  await actions.shellRequest({ type: "profile.export", directory: response.result.paths[0], profile, force: false });
}
