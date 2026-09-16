import type { StoryFact, StoryPathNode, StoryPayload } from "../shared/types.js";
import { isFactEndState, type FactState } from "../shared/fact-state.js";
import { estimateTokens } from "../shared/tokens.js";
import {
  activeLeaf,
  factLabel,
  storyChapters,
  DESKTOP_THEMES,
  type DesktopTheme,
  type RendererActions,
  type RendererState
} from "./renderer-model.js";
import { renderLauncher } from "./renderer-launcher-view.js";
import { renderSettingsEditor } from "./renderer-settings-view.js";
import { actionButton, el } from "./renderer-dom.js";
import { renderTitlebar, renderRail, renderFeedbackStack } from "./renderer-shell-view.js";
import { renderLibraryDestination } from "./renderer-library-view.js";
import { renderInspector } from "./renderer-inspector-view.js";
import { renderKeysSheet } from "./renderer-keys-view.js";
import { renderPalette } from "./renderer-palette-view.js";
import { renderWriting, renderPartMenu } from "./renderer-manuscript-view.js";

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
  if (state.popover?.kind === "keys") shell.append(renderKeysSheet(actions));
  if (state.popover?.kind === "palette") shell.append(renderPalette(state, actions, !hadPopover));
  if (state.popover?.kind === "part-menu") {
    const menu = renderPartMenu(state, actions, state.popover.partId);
    if (menu !== null) shell.append(menu);
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
    if (state.tab === "map") content.append(renderMap(story, actions));
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

function renderFacts(story: StoryPayload, state: RendererState, actions: RendererActions): HTMLElement {
  if (!state.factConsistencySeen) queueMicrotask(() => actions.acknowledgeFactConsistencySeen());
  const panel = el("div", "panel");
  const factControls = el("div", "panel-heading-actions",
    actionButton("new-fact", "+ New Fact", actions.createFact),
    actionButton("facts-check-line", state.factConsistencyBusy ? "Checking…" : "Check line", () => actions.runFactConsistency("story-line")),
    actionButton("facts-check-chapter", state.factConsistencyBusy ? "Checking…" : "Check chapter", () => actions.runFactConsistency("chapter")),
    state.factConsistency === null ? "" : actionButton("facts-show-findings", "Show findings", actions.showFactConsistency)
  );
  (factControls.querySelectorAll("button") as NodeListOf<HTMLButtonElement>).forEach((button) => { button.disabled = state.factConsistencyBusy; });
  panel.append(panelHeading("Story Facts", "Durable story memory travels with the active line.", factControls));
  const budget = document.createElement("form");
  budget.className = "facts-budget-form";
  const budgetInput = document.createElement("input");
  budgetInput.type = "number";
  budgetInput.min = "1";
  budgetInput.step = "1";
  budgetInput.placeholder = "No limit";
  budgetInput.value = story.factsBudgetTokens === undefined ? "" : String(story.factsBudgetTokens);
  budgetInput.dataset.preserve = "facts-budget";
  budgetInput.setAttribute("aria-label", "Facts budget in tokens");
  const budgetSave = actionButton("facts-budget-save", "Save budget", () => {
    const value = budgetInput.value.trim();
    actions.setFactsBudget(value.length === 0 ? null : Number(value));
  });
  budget.addEventListener("submit", (event) => { event.preventDefault(); budgetSave.click(); });
  budget.append(el("label", "facts-budget-label", "Facts budget", budgetInput), budgetSave);
  const list = el("div", "fact-list");
  if (story.facts.length === 0) list.append(el("p", "empty-copy", "No Facts yet. Add one for a person, place, promise, or rule."));
  story.facts.forEach((fact, index) => list.append(renderFact(fact, index, story.facts.length, actions)));
  panel.append(budget, list, el("div", "panel-note", `Facts budget: ${story.factsBudgetTokens === undefined ? "open" : `${story.factsBudgetTokens.toLocaleString()} tokens`}.`));
  if (state.factConsistency !== null) panel.append(renderFactConsistency(state.factConsistency, story));
  return panel;
}

function renderFactConsistency(run: import("../shared/fact-consistency-contract.js").FactConsistencyRun, story: StoryPayload): HTMLElement {
  const findings = run.parts.flatMap((part) => part.findings.map((finding) => ({ part, finding })));
  const card = el("section", "consistency-card");
  card.append(el("div", "consistency-heading", el("span", "eyebrow", "Fact check"), el("strong", "", `${run.scope} · ${new Date(run.checkedAt).toLocaleString()}`)));
  if (findings.length === 0) {
    card.append(el("p", "empty-copy", "No contradictions found in the checked line."));
    return card;
  }
  const list = el("div", "consistency-findings");
  for (const { part, finding } of findings) {
    const fact = story.facts.find((candidate) => candidate.id === finding.fact_id);
    list.append(el("article", "consistency-finding",
      el("strong", "", fact?.name ?? "Fact"),
      el("p", "", finding.statement),
      el("blockquote", "", finding.quote),
      el("span", "fact-state-meta", `part ${part.partId.slice(0, 8)}`)
    ));
  }
  card.append(list);
  return card;
}

function renderFact(fact: StoryFact, index: number, count: number, actions: RendererActions): HTMLElement {
  const item = el("article", "fact-card");
  item.dataset.preserve = `fact-card:${fact.id}`;
  const state = fact.states[0];
  const body = state !== undefined && "text" in state ? state.text : "End State";
  const head = el("div", "fact-head", el("span", "fact-index", String(index + 1).padStart(2, "0")), el("h3", "", factLabel(fact)), el("span", "fact-tag", fact.tag?.trim() || "no tag"));
  const controls = el("div", "fact-controls");
  controls.append(
    actionButton("fact-up", "↑", () => actions.moveFact(fact, -1), "Move Fact earlier"),
    actionButton("fact-down", "↓", () => actions.moveFact(fact, 1), "Move Fact later"),
    actionButton("fact-edit", "Edit", () => actions.editFact(fact)),
    actionButton("fact-delete", "Delete", () => actions.deleteFact(fact))
  );
  (controls.querySelector(".fact-up") as HTMLButtonElement).disabled = index === 0;
  (controls.querySelector(".fact-down") as HTMLButtonElement).disabled = index === count - 1;
  const stateDetails = document.createElement("details");
  stateDetails.className = "fact-states";
  stateDetails.dataset.preserve = `fact:states:${fact.id}`;
  const stateSummary = document.createElement("summary");
  stateSummary.textContent = `${fact.states.length} state${fact.states.length === 1 ? "" : "s"}`;
  stateDetails.append(stateSummary);
  for (const factState of fact.states) {
    const stateRow = el("div", "fact-state-row");
    stateRow.dataset.preserve = `fact-state:${fact.id}:${factState.id}`;
    const stateText = isTextFactState(factState) ? factState.text : "End State";
    const anchor = factState.anchorPartId === undefined ? "story-wide" : `after ${factState.anchorPartId.slice(0, 8)}`;
    stateRow.append(el("div", "fact-state-copy", el("strong", "", stateText.slice(0, 160)), el("span", "fact-state-meta", anchor)));
    const stateControls = el("div", "fact-state-controls");
    stateControls.append(actionButton("fact-state-edit", "Edit", () => actions.editFactState(fact, factState)));
    stateControls.append(actionButton("fact-state-delete", "Delete", () => actions.deleteFactState(fact, factState)));
    stateRow.append(stateControls);
    stateDetails.append(stateRow);
  }
  stateDetails.append(actionButton("fact-state-add", "+ Add state", () => actions.addFactState(fact)));
  const metadata = [
    fact.activation,
    fact.priority === undefined || fact.priority === "normal" ? "normal priority" : `${fact.priority} priority`,
    fact.keys.length === 0 ? "no keys" : `${fact.keys.length} key${fact.keys.length === 1 ? "" : "s"}`,
    fact.budgetTokens === undefined ? "no Fact cap" : `${fact.budgetTokens.toLocaleString()} token cap`,
    `${fact.states.length} state${fact.states.length === 1 ? "" : "s"}`
  ];
  item.append(head, el("p", "fact-body", body), el("div", "fact-meta", metadata.join(" · ")), stateDetails, controls);
  return item;
}

function renderChapters(story: StoryPayload, state: RendererState, actions: RendererActions): HTMLElement {
  const panel = el("div", "panel");
  const controls = el("div", "panel-heading-actions", actionButton("new-chapter", "+ New chapter", actions.createChapter), state.chapterUndo === null ? "" : actionButton("restore-chapter", "Restore removed", actions.restoreChapter));
  panel.append(panelHeading("Chapters", "Name the turns in the manuscript and keep summaries near their breaks.", controls));
  const list = el("div", "chapter-list");
  const chapters = storyChapters(story);
  for (const [index, chapter] of chapters.entries()) {
    const openingBreak = index === 0 ? null : chapters[index - 1]?.closedBy ?? null;
    const summary = chapter.summary?.text === undefined ? undefined : { id: chapter.summary.id, text: chapter.summary.text };
    list.append(renderChapter(
      { id: openingBreak?.id ?? "", parentPartId: openingBreak?.parentPartId ?? "", title: chapter.title || (index === 0 ? "Opening chapter" : "Untitled chapter"), createdAt: openingBreak?.createdAt ?? story.createdAt },
      index === 0,
      actions,
      summary,
      chapter.closedBy?.id
    ));
  }
  panel.append(list);
  return panel;
}

function renderMap(story: StoryPayload, actions: RendererActions): HTMLElement {
  const panel = el("div", "panel map-panel");
  panel.append(panelHeading("Branch map", "Every take stays visible. Focus a leaf to return to the manuscript."));
  const children = new Map<string | null, typeof story.nodes>();
  for (const node of story.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const activeIds = new Set(story.path.map((node) => node.id));
  const seen = new Set<string>();
  const tree = el("div", "map-tree");
  const appendNode = (node: (typeof story.nodes)[number], depth: number): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const row = el("div", `map-node ${activeIds.has(node.id) ? "active" : ""}`);
    row.style.setProperty("--map-depth", String(depth));
    const focus = actionButton("map-focus", activeIds.has(node.id) ? "current" : "focus", () => actions.switchNode(node.id));
    focus.dataset.preserve = `map:${node.id}`;
    row.append(el("span", "map-node-marker", activeIds.has(node.id) ? "◆" : "◇"), el("span", "map-node-copy", el("strong", "", node.preview || "Untitled part"), el("span", "map-node-meta", `${node.words.toLocaleString()} words · ${node.childCount} take${node.childCount === 1 ? "" : "s"}`)), focus);
    tree.append(row);
    for (const child of children.get(node.id) ?? []) appendNode(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) appendNode(root, 0);
  if (tree.childElementCount === 0) tree.append(el("p", "empty-copy", "The map is empty until the first line is written."));
  panel.append(tree);
  const anchors = story.facts.flatMap((fact) => fact.states.filter((state) => state.anchorPartId !== undefined).map((state) => ({ fact, state })));
  const lens = el("section", "map-fact-lens");
  lens.append(el("div", "panel-subheading", el("span", "eyebrow", "Fact lens"), el("strong", "", `${anchors.length} anchored state${anchors.length === 1 ? "" : "s"}`)));
  if (anchors.length === 0) lens.append(el("p", "empty-copy", "Anchored Fact states appear here."));
  for (const { fact, state } of anchors) {
    const anchor = state.anchorPartId;
    if (anchor === undefined) continue;
    const node = story.nodes.find((candidate) => candidate.id === anchor);
    const button = actionButton("map-fact-anchor", `${factLabel(fact)} · ${node?.preview ?? anchor.slice(0, 8)}`, () => actions.switchNode(anchor));
    button.dataset.preserve = `map-fact:${fact.id}:${anchor}`;
    lens.append(button);
  }
  panel.append(lens);
  return panel;
}

function renderChapter(chapter: { id: string; parentPartId: string; title: string; createdAt: string }, opening: boolean, actions: RendererActions, summary?: Pick<StoryPathNode, "id" | "text">, summaryBreakId?: string): HTMLElement {
  const item = el("article", "chapter-card");
  item.dataset.preserve = `chapter:${chapter.id || "opening"}`;
  const copy = el("div", "chapter-card-copy", el("h3", "", chapter.title), el("p", "", opening ? "The story opening" : "Break in the active line"));
  if (summary !== undefined) copy.append(el("p", "chapter-summary-preview", summary.text.slice(0, 180) || "Empty summary"));
  item.append(el("span", "chapter-index", opening ? "01" : "•"), copy);
  const controls = el("div", "chapter-controls");
  controls.append(actionButton("chapter-rename", "Rename", () => actions.renameChapter(chapter)));
  if (summaryBreakId !== undefined) controls.append(actionButton("chapter-summarize", "Summarize", () => actions.summarizeChapter({ ...chapter, id: summaryBreakId })));
  if (!opening) controls.append(actionButton("chapter-remove", "Remove", () => actions.removeChapter(chapter)));
  if (summary !== undefined) controls.append(actionButton("chapter-summary-edit", "Edit summary", () => actions.editChapterSummary(chapter, summary)));
  item.append(controls);
  return item;
}

function renderSettings(state: RendererState, actions: RendererActions): HTMLElement {
  const desktop = renderDesktopSection(state, actions);
  const transfer = el("div", "settings-transfer-bar",
    actionButton("profile-import", "Import profile", () => { void importProfile(actions); }),
    actionButton("profile-export", "Export profile", () => { void exportProfile(actions, state.settingsEditor?.draft.selectedProfileId ?? null); })
  );
  if (state.settings === null) return el("div", "settings-editor-stack", desktop, transfer, el("div", "panel settings-panel", el("p", "empty-copy", "Loading settings…")));
  if (state.settingsEditor === null || state.settings.document === null) {
    return el("div", "settings-editor-stack", desktop, transfer, el("div", "panel settings-panel", el("p", "empty-copy", "This settings document is read-only in the current project.")));
  }
  const editor = state.settingsEditor;
  return el("div", "settings-editor-stack", desktop, transfer, renderSettingsEditor({
    document: editor.draft.document,
    draft: editor.draft,
    discovery: editor.discovery,
    busy: editor.busy,
    providerStatus: editor.providerStatus,
    error: editor.error,
    fieldErrors: editor.fieldErrors,
    pendingRevision: state.settings.pendingRevision,
    activeRevision: state.settings.activeRevision,
    lastActivationOutcome: state.settings.lastActivationOutcome
  }, actions.settingsEditor));
}

/** The desktop display controls (theme, directions) live at the top of
 * Settings until phase 4 builds the typed theme picker (D-19). */
function renderDesktopSection(state: RendererState, actions: RendererActions): HTMLElement {
  const theme = document.createElement("select");
  theme.className = "theme-select settings-control";
  theme.dataset.preserve = "theme-select";
  theme.setAttribute("aria-label", "Desktop theme");
  for (const value of DESKTOP_THEMES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === state.theme;
    theme.append(option);
  }
  theme.value = state.theme;
  theme.addEventListener("change", () => actions.setTheme(theme.value as DesktopTheme));
  const directions = actionButton("directions-toggle", state.showDirections ? "directions on" : "directions off", () => actions.setDirections(!state.showDirections));
  directions.setAttribute("aria-pressed", String(state.showDirections));
  directions.title = state.showDirections ? "Hide part directions" : "Show part directions";
  return el("div", "settings-section",
    el("div", "settings-section-heading", el("h3", "", "Desktop"), el("p", "", "Display only; this does not change story data.")),
    el("div", "settings-form",
      el("label", "settings-field", "Theme", theme),
      el("label", "settings-field", "Directions", directions)
    )
  );
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

function panelHeading(title: string, description: string, control?: HTMLElement): HTMLElement {
  const heading = el("div", "panel-heading", el("div", "panel-heading-copy", el("span", "eyebrow", "Workspace"), el("h2", "", title), el("p", "", description)));
  if (control !== undefined) heading.append(control);
  return heading;
}

function metricRow(label: string, value: string): HTMLElement {
  return el("div", "metric-row", el("span", "", label), el("strong", "", value));
}

function isTextFactState(state: FactState): state is Extract<FactState, { text: string }> {
  return !isFactEndState(state);
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
