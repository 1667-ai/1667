/** Facts destination (⌘3, 2a): a scoped list, an inline editor sheet, and
 * the consistency check (DESIGN_SPEC.md §2; phase spec §3;
 * docs/design/fact-consistency-check.md). Replaces the card list that used
 * to live in `renderer-view.ts`. */
import { isFactEndState, resolveFactState, type FactState } from "../shared/fact-state.js";
import { estimateTokens } from "../shared/tokens.js";
import { rememberedLeafId } from "../shared/story-model.js";
import type { FactConsistencyRun, FactConsistencyRunPart } from "../shared/fact-consistency-contract.js";
import type { StoryFact, StoryPayload } from "../shared/types.js";
import { actionButton, bindDraftInput, el } from "./renderer-dom.js";
import { button, field, scalar, segmented, textArea } from "./renderer-controls.js";
import {
  effectiveFocusedPartId,
  factLabel,
  storyChapterInfo,
  storyChapters,
  type RendererActions,
  type RendererState
} from "./renderer-model.js";
import {
  FACTS_LIST_SCOPES,
  FACT_ACTIVATIONS,
  FACT_ACTIVATION_LABELS,
  FACT_PRIORITIES,
  FACT_PRIORITY_LABELS,
  describeFactChanges,
  factBodyEditable,
  factEditorDirty,
  factMatchesFilter,
  factMatchesScope,
  factRowMeta,
  factSingleStateText,
  orderedFactStates,
  type FactDraft,
  type FactEditorState
} from "./renderer-facts-model.js";

export function renderFacts(story: StoryPayload, state: RendererState, actions: RendererActions): HTMLElement {
  if (!state.factConsistencySeen) queueMicrotask(() => actions.acknowledgeFactConsistencySeen());
  const focusedId = effectiveFocusedPartId(state, story);
  const focusedIndex = focusedId === null ? -1 : story.path.findIndex((node) => node.id === focusedId);
  const destination = el("div", "facts-destination");
  destination.append(
    renderFactsList(story, state, actions, focusedIndex),
    renderFactsSheetPane(story, state, actions, focusedIndex)
  );
  return destination;
}

function currentLineLabel(story: StoryPayload): string {
  const leaf = story.path.at(-1);
  if (leaf === undefined) return "current";
  const tag = story.tags.find((candidate) => candidate.nodeId === rememberedLeafId(story, leaf.id));
  return tag?.name ?? "current";
}

function renderFactsList(story: StoryPayload, state: RendererState, actions: RendererActions, focusedIndex: number): HTMLElement {
  const pane = el("section", "facts-list");

  const newButton = button("primary", "+ New", undefined, () => actions.createFact());
  newButton.classList.add("new-fact");
  pane.append(el("div", "panel-heading",
    el("div", "panel-heading-copy", el("span", "eyebrow", `Facts · line ${currentLineLabel(story)}`)),
    newButton
  ));

  const scopeOptions = FACTS_LIST_SCOPES.map((scope) => ({
    value: scope,
    label: scope === "all"
      ? `all ${story.facts.length}`
      : scope === "in-force" ? "in force" : scope
  }));
  pane.append(segmented(scopeOptions, state.factsScope, (scope) => actions.setFactsScope(scope)));

  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.className = "field-textarea facts-filter";
  filterInput.placeholder = "Filter facts…";
  filterInput.value = state.factsFilter;
  filterInput.dataset.preserve = "facts-filter";
  bindDraftInput(filterInput, () => actions.setFactsFilter(filterInput.value));
  pane.append(filterInput);

  pane.append(renderBudgetMeter(story, focusedIndex));

  const visible = story.facts.filter((fact) =>
    factMatchesScope(fact, story.path, focusedIndex, state.factsScope) && factMatchesFilter(fact, state.factsFilter));
  const list = el("div", "fact-list");
  if (story.facts.length === 0) {
    list.append(el("p", "empty-copy", "No Facts yet. Add one for a person, place, promise, or rule."));
  } else if (visible.length === 0) {
    list.append(el("p", "empty-copy", "No Facts match this scope or filter."));
  }
  for (const fact of visible) {
    list.append(renderFactRow(fact, story, state, actions, focusedIndex, story.facts.indexOf(fact)));
  }
  pane.append(list);
  pane.append(renderFactCheckCard(story, state, actions, focusedIndex));
  return pane;
}

function renderBudgetMeter(story: StoryPayload, focusedIndex: number): HTMLElement {
  const wrapper = el("div", "facts-budget-meter");
  const label = focusedIndex === -1 ? "budget" : `budget · in force at ¶ ${focusedIndex + 1}`;
  const prefix = story.path.slice(0, Math.max(focusedIndex, -1) + 1);
  const used = story.facts.reduce((sum, fact) => {
    const resolution = focusedIndex === -1 ? { kind: "off-path" as const } : resolveFactState(fact, prefix);
    return resolution.kind === "active" ? sum + estimateTokens(resolution.state.text) : sum;
  }, 0);
  wrapper.append(el("p", "meter-caption", label));
  const limit = story.factsBudgetTokens;
  if (limit === undefined) {
    wrapper.append(el("p", "meter-caption", `${used.toLocaleString()} tok`));
    return wrapper;
  }
  const over = used > limit;
  const meter = el("div", `context-meter${over ? " over" : ""}`);
  const fill = el("span", "context-meter-fill");
  fill.style.width = `${Math.min(100, (100 * used) / limit)}%`;
  meter.append(fill);
  wrapper.append(meter, el("p", "meter-caption", `${used.toLocaleString()} / ${limit.toLocaleString()} tok`));
  return wrapper;
}

function renderFactRow(
  fact: StoryFact,
  story: StoryPayload,
  state: RendererState,
  actions: RendererActions,
  focusedIndex: number,
  factIndex: number
): HTMLElement {
  const inScope = factMatchesScope(fact, story.path, focusedIndex, "in-force");
  const selected = state.factEditor?.factId === fact.id;
  const item = el("article", `fact-card fact-row${selected ? " selected" : ""}${inScope ? "" : " dim"}`);
  item.dataset.preserve = `fact-card:${fact.id}`;
  const select = actionButton("fact-row-select", "", () => actions.selectFact(fact.id));
  select.append(
    el("div", "fact-head",
      el("h3", "", factLabel(fact)),
      el("span", "fact-tag", `${(fact.tag?.trim() || "no tag").toUpperCase()} · ${fact.activation === "always" ? "always" : "on keys"}`)
    ),
    el("p", "fact-meta", factRowMeta(fact, story.path, focusedIndex))
  );
  item.append(select);
  const controls = el("div", "fact-controls");
  const up = button("quiet", "↑", undefined, () => actions.moveFact(fact, -1));
  up.classList.add("fact-up");
  up.disabled = factIndex === 0;
  const down = button("quiet", "↓", undefined, () => actions.moveFact(fact, 1));
  down.classList.add("fact-down");
  down.disabled = factIndex === story.facts.length - 1;
  controls.append(up, down);
  item.append(controls);
  return item;
}

function renderFactCheckCard(story: StoryPayload, state: RendererState, actions: RendererActions, focusedIndex: number): HTMLElement {
  const card = el("section", "fact-check");
  card.append(el("span", "eyebrow", "Fact check"));
  const focusedNode = focusedIndex === -1 ? null : story.path[focusedIndex] ?? null;
  const chapterParts = focusedNode === null
    ? 0
    : storyChapters(story).find((chapter) => chapter.parts.some((part) => part.id === focusedNode.id))?.parts.length ?? 0;
  const lineParts = story.path.length;
  const busy = state.factConsistencyBusy;
  const chapterButton = button("secondary", busy ? "Checking…" : `Check chapter · ${chapterParts} parts`, undefined, () => actions.runFactConsistency("chapter"), chapterParts === 0 ? "Focus a part first" : undefined);
  chapterButton.classList.add("facts-check-chapter");
  chapterButton.disabled = busy || chapterParts === 0;
  const lineButton = button("secondary", busy ? "Checking…" : `Check line · ${lineParts} parts`, undefined, () => actions.runFactConsistency("story-line"), lineParts === 0 ? "Write a part first" : undefined);
  lineButton.classList.add("facts-check-line");
  lineButton.disabled = busy || lineParts === 0;
  card.append(el("div", "fact-check-actions", chapterButton, lineButton));
  if (busy) card.append(el("p", "meter-caption", "⟳ checking · esc stops"));
  card.append(el("p", "meter-caption", "one request per part · parts with no Fact in force are skipped"));
  return card;
}

function renderFactsSheetPane(story: StoryPayload, state: RendererState, actions: RendererActions, focusedIndex: number): HTMLElement {
  const pane = el("section", "facts-sheet");
  if (state.factConsistency !== null) pane.append(renderFindings(state.factConsistency, story, state, actions));
  const editor = state.factEditor;
  if (editor === null) {
    pane.append(el("div", "fact-sheet-empty", el("p", "empty-copy", "Select a Fact, or + New.")));
    return pane;
  }
  const fact = editor.factId === null ? null : story.facts.find((candidate) => candidate.id === editor.factId) ?? null;
  if (editor.factId !== null && fact === null) {
    pane.append(el("div", "fact-sheet-empty", el("p", "empty-copy", "This Fact no longer exists.")));
    return pane;
  }
  pane.append(renderFactSheet(fact, editor, story, actions, focusedIndex));
  return pane;
}

function renderFactSheet(fact: StoryFact | null, editor: FactEditorState, story: StoryPayload, actions: RendererActions, focusedIndex: number): HTMLElement {
  const sheet = el("section", "fact-sheet");
  const draft = editor.draft;
  const dirty = factEditorDirty(fact, draft);
  const tokens = fact === null ? 0 : estimateTokens(factSingleStateText(fact) ?? fact.states.map((s) => (isFactEndState(s) ? "" : s.text)).join(" "));
  sheet.append(el("div", "sheet-head",
    el("span", "eyebrow", "Edit fact"),
    el("span", "sheet-saved", fact === null ? "not yet saved" : `saved · ${tokens.toLocaleString()} tok`)
  ));
  sheet.append(el("h2", "fact-sheet-title", draft.name.trim() || (fact === null ? "New Fact" : factLabel(fact))));

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "field-textarea";
  nameInput.value = draft.name;
  nameInput.dataset.preserve = "fact-editor-name";
  bindDraftInput(nameInput, () => actions.setFactDraft({ name: nameInput.value }));

  const tagInput = document.createElement("input");
  tagInput.type = "text";
  tagInput.className = "field-textarea";
  tagInput.setAttribute("list", "fact-tag-options");
  tagInput.value = draft.tag;
  tagInput.dataset.preserve = "fact-editor-tag";
  bindDraftInput(tagInput, () => actions.setFactDraft({ tag: tagInput.value }));
  const tagOptions = el("datalist");
  tagOptions.id = "fact-tag-options";
  for (const tag of new Set(story.facts.map((candidate) => candidate.tag?.trim()).filter((value): value is string => Boolean(value)))) {
    tagOptions.append(el("option", "", tag));
  }

  const activationControl = segmented(
    FACT_ACTIVATIONS.map((value) => ({ value, label: FACT_ACTIVATION_LABELS[value] })),
    draft.activation,
    (value) => actions.setFactDraft({ activation: value })
  );
  activationControl.classList.add("fact-activation");
  const priorityControl = segmented(
    FACT_PRIORITIES.map((value) => ({ value, label: FACT_PRIORITY_LABELS[value] })),
    draft.priority,
    (value) => actions.setFactDraft({ priority: value })
  );
  priorityControl.classList.add("fact-priority");

  const fieldsRow = el("div", "fact-sheet-fields");
  fieldsRow.append(
    field("Name", nameInput),
    el("div", "", tagOptions, field("Tag", tagInput)),
    field("Activation", activationControl),
    field("Priority", priorityControl),
    field("Keys", renderFactKeysField(draft, actions)),
    field("Fact cap", renderFactCapScalar(draft, actions))
  );
  sheet.append(fieldsRow);

  const isSimple = fact === null || factBodyEditable(fact);
  if (isSimple) {
    const body = textArea(draft.body, (value) => actions.setFactDraft({ body: value }), { prose: true, rows: 6 });
    body.classList.add("fact-editor-body");
    body.dataset.preserve = "fact-editor-body";
    sheet.append(field("Body", body));
    // A saved simple Fact (one story-wide text state) still needs a way to
    // acquire its first anchored state or an End State; a brand-new,
    // never-saved draft (`fact === null`) has no Fact id yet to add one to.
    if (fact !== null) sheet.append(renderStatesFooter(fact, actions, dirty));
  } else {
    sheet.append(renderStatesSection(fact!, story, actions, focusedIndex, dirty));
  }

  const changes = fact === null ? [] : describeFactChanges(fact, draft);
  if (dirty) {
    const save = button("primary", "Save fact", "⌘S", () => actions.saveFactEditor());
    save.classList.add("fact-editor-save");
    const revert = button("quiet", "Revert", undefined, () => actions.revertFactEditor());
    revert.classList.add("fact-editor-revert");
    const summary = changes.length === 0
      ? "not yet saved"
      : `${changes.length} change${changes.length === 1 ? "" : "s"} · ${changes.join(" · ")}`;
    sheet.append(el("div", "fact-pending-bar", el("p", "fact-pending-summary", summary), el("div", "settings-actions", save, revert)));
  }

  if (fact !== null) {
    const deleteButton = button("destructive", "Delete fact…", undefined, () => actions.deleteFact(fact));
    deleteButton.classList.add("fact-editor-delete");
    sheet.append(el("div", "fact-sheet-footer", deleteButton));
  }
  return sheet;
}

function renderFactCapScalar(draft: FactDraft, actions: RendererActions): HTMLElement {
  const raw = draft.budget.trim();
  const parsed = raw.length === 0 ? null : Number(raw);
  const invalid = raw.length > 0 && (!Number.isFinite(parsed) || parsed! <= 0);
  const control = scalar({
    value: invalid ? null : parsed,
    min: 1,
    max: 1_000_000,
    step: 100,
    defaultValue: 2_000,
    id: "fact-cap",
    placeholder: "no cap",
    invalid,
    onChange: (value) => actions.setFactDraft({ budget: value })
  });
  return control;
}

function renderFactKeysField(draft: FactDraft, actions: RendererActions): HTMLElement {
  const wrapper = el("div", "fact-keys-field");
  for (const key of draft.keys) {
    const keyChip = document.createElement("button");
    keyChip.type = "button";
    keyChip.className = "chip outline fact-key-chip";
    keyChip.title = "Remove key";
    keyChip.textContent = key;
    keyChip.addEventListener("click", () => actions.setFactDraft({ keys: draft.keys.filter((candidate) => candidate !== key) }));
    wrapper.append(keyChip);
  }
  const input = document.createElement("input");
  input.type = "text";
  input.className = "fact-key-input";
  input.dataset.preserve = "fact-editor-key-input";
  input.placeholder = "+ key";
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const value = input.value.trim();
    if (value.length === 0) return;
    if (!draft.keys.includes(value)) actions.setFactDraft({ keys: [...draft.keys, value] });
    input.value = "";
  });
  wrapper.append(input);
  return wrapper;
}

function renderStatesSection(fact: StoryFact, story: StoryPayload, actions: RendererActions, focusedIndex: number, dirty: boolean): HTMLElement {
  const ordered = orderedFactStates(fact, story.path);
  const resolution = focusedIndex < 0 ? null : resolveFactState(fact, story.path.slice(0, focusedIndex + 1));
  const section = el("div", "fact-states-section");
  const inForceLabel = focusedIndex < 0 ? "walked in story order" : `walked in story order · ● in force at ¶ ${focusedIndex + 1}`;
  section.append(el("div", "panel-subheading", el("span", "eyebrow", `States · ${fact.states.length}`), el("span", "", inForceLabel)));
  const list = el("div", "fact-states-list");
  ordered.forEach((state, index) => {
    const inForce = resolution !== null && resolution.kind !== "off-path" && resolution.state.id === state.id;
    list.append(renderStateRow(fact, state, index + 1, inForce, story, actions));
  });
  section.append(list);
  section.append(renderStatesFooter(fact, actions, dirty));
  return section;
}

/** The three one-click state-add links (§3), shared by the full STATES list
 * and the simplified Body editor — a simple Fact needs the same way to
 * acquire its first anchored state or End State. While the editor is dirty
 * they are disabled: adding a state re-fetches the Fact from the server,
 * which would drop an unsaved edit sitting only in the draft. */
function renderStatesFooter(fact: StoryFact, actions: RendererActions, dirty: boolean): HTMLElement {
  const reason = dirty ? "Save or revert this Fact first" : undefined;
  const anchorButton = button("quiet", "+ State anchored here", undefined, () => actions.addFactStateAnchored(fact), reason);
  const wideButton = button("quiet", "+ Story-wide state", undefined, () => actions.addFactStateStoryWide(fact), reason);
  const endButton = button("quiet", "+ End here", undefined, () => actions.addFactStateEnd(fact), reason);
  return el("div", "fact-states-footer", anchorButton, wideButton, endButton);
}

function renderStateRow(fact: StoryFact, state: FactState, number: number, inForce: boolean, story: StoryPayload, actions: RendererActions): HTMLElement {
  const row = el("div", `fact-state-row${inForce ? " in-force" : ""}`);
  row.dataset.preserve = `fact-state:${fact.id}:${state.id}`;
  const text = isFactEndState(state) ? "End State — the Fact stops here." : state.text;
  const anchorIndex = state.anchorPartId === undefined ? -1 : story.path.findIndex((node) => node.id === state.anchorPartId);
  const meta = state.anchorPartId === undefined
    ? "story-wide"
    : anchorIndex === -1 ? "anchored off this line" : `anchored after ¶ ${anchorIndex + 1}`;
  row.append(
    el("span", "fact-state-number", `${inForce ? "●" : ""}${number}`),
    el("div", "fact-state-copy", el("strong", "", text), el("span", "fact-state-meta", meta))
  );
  const controls = el("div", "fact-state-controls");
  controls.append(actionButton("fact-state-edit", "edit", () => actions.editFactState(fact, state)));
  if (fact.states.length > 1) controls.append(actionButton("fact-state-delete", "delete", () => actions.deleteFactState(fact, state)));
  row.append(controls);
  return row;
}

function renderFindings(run: FactConsistencyRun, story: StoryPayload, state: RendererState, actions: RendererActions): HTMLElement {
  const card = el("section", "fact-findings");
  const scopeLabel = run.scope === "story-line" ? "line" : `chapter ${storyChapterInfo(story, { id: run.anchor.partId }).number}`;
  const totalFindings = run.parts.reduce((sum, part) => sum + part.findings.length, 0);
  card.append(el("div", "fact-findings-head", el("span", "eyebrow", `Findings · ${scopeLabel}`)));
  card.append(el("p", "fact-findings-summary", `${run.parts.length} part${run.parts.length === 1 ? "" : "s"} checked · ${totalFindings} finding${totalFindings === 1 ? "" : "s"}`));
  const rows = run.parts.flatMap((part, partIndex) => part.findings.map((finding, findingIndex) => ({ part, partIndex, finding, key: `${part.partId}#${findingIndex}` })));
  const visible = rows.filter((row) => !state.factConsistencyDismissed.includes(row.key));
  if (visible.length === 0) {
    card.append(el("p", "empty-copy", "No contradictions found."));
    return card;
  }
  for (const row of visible) card.append(renderFinding(row, story, actions));
  return card;
}

function renderFinding(
  row: { readonly part: FactConsistencyRunPart; readonly finding: FactConsistencyRun["parts"][number]["findings"][number]; readonly key: string },
  story: StoryPayload,
  actions: RendererActions
): HTMLElement {
  const fact = story.facts.find((candidate) => candidate.id === row.finding.fact_id);
  const partIndex = story.path.findIndex((node) => node.id === row.part.partId);
  const item = el("article", "finding");
  item.append(el("div", "finding-head",
    el("strong", "", fact === undefined ? "Fact" : factLabel(fact)),
    el("span", "finding-position", partIndex === -1 ? "off this line" : `¶ ${partIndex + 1}`)
  ));
  item.append(el("p", "finding-statement", row.finding.statement));
  const quote = el("blockquote", "finding-quote", el("mark", "", row.finding.quote));
  item.append(quote);
  const controls = el("div", "finding-controls");
  const openPart = actionButton("finding-open-part", "Open ¶", () => { actions.focusPart(row.part.partId); actions.setTab("write"); });
  openPart.disabled = partIndex === -1;
  controls.append(openPart, actionButton("finding-open-fact", "Open fact", () => actions.selectFact(row.finding.fact_id)), actionButton("finding-dismiss", "Dismiss", () => actions.dismissFinding(row.key)));
  item.append(controls);
  return item;
}
