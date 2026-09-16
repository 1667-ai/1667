import type { StoryPathNode, StoryPayload } from "../shared/types.js";
import { effectiveFactAtPath } from "../shared/fact-state.js";
import { rememberedLeafId } from "../shared/story-model.js";
import { actionButton, bindDraftInput, el } from "./renderer-dom.js";
import { renderRequestContext } from "./renderer-context.js";
import {
  ASIDE_CURRENT_KEY,
  ASIDE_UNANCHORED_KEY,
  asideAnchorKey,
  effectiveFocusedPartId,
  factLabel,
  type RendererActions,
  type RendererState
} from "./renderer-model.js";

const COLLAPSED_STORAGE_KEY = "1667.desktop.inspector-collapsed";

function loadCollapsedSections(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function persistCollapsedSections(collapsed: ReadonlySet<string>): void {
  try { localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsed])); } catch { /* private mode */ }
}

/** Module-level so the collapsed set survives re-renders without living in
 * `RendererState` (it is presentation only, never read back by any command). */
const collapsedSections = loadCollapsedSections();

/** Force-expands an inspector section from outside a click — the keyboard
 * commands `a` (Aside), `n` (Author's Note), and ⌃g (Context) all reveal
 * their section this way. Updates the persisted collapsed set and, when the
 * section is already in the DOM, reflects the change immediately without a
 * full re-render. */
export function expandInspectorSection(key: string): void {
  if (collapsedSections.delete(key)) persistCollapsedSections(collapsedSections);
  const section = document.querySelector<HTMLElement>(`[data-inspector-section="${key}"]`);
  const header = section?.querySelector<HTMLButtonElement>(".inspector-section-header");
  const body = section?.querySelector<HTMLElement>(".inspector-section-body");
  if (header === null || header === undefined || body === null || body === undefined) return;
  body.hidden = false;
  header.setAttribute("aria-expanded", "true");
}

function inspectorSection(key: string, label: string, count: number, content: readonly HTMLElement[]): HTMLElement {
  const section = el("section", "inspector-section");
  section.dataset.inspectorSection = key;
  const header = document.createElement("button");
  header.type = "button";
  header.className = "eyebrow inspector-section-header";
  header.append(document.createTextNode(label), el("span", "inspector-section-count", String(count)));
  const body = el("div", "inspector-section-body", ...content);
  const applyCollapsed = (): void => {
    const collapsed = collapsedSections.has(key);
    body.hidden = collapsed;
    header.setAttribute("aria-expanded", String(!collapsed));
  };
  applyCollapsed();
  header.addEventListener("click", () => {
    if (collapsedSections.has(key)) collapsedSections.delete(key); else collapsedSections.add(key);
    persistCollapsedSections(collapsedSections);
    applyCollapsed();
  });
  section.append(header, body);
  return section;
}

/** Inspector D-03: contextual to the focused part. Sections stay in a fixed
 * order and collapse to eyebrow + count; they never disappear. */
export function renderInspector(state: RendererState, actions: RendererActions): HTMLElement {
  const aside = el("aside", "inspector");
  const story = state.story;
  if (story === null) return aside;
  const focusedId = effectiveFocusedPartId(state, story);
  const focusedIndex = focusedId === null ? -1 : story.path.findIndex((node) => node.id === focusedId);
  const focusedNode = focusedIndex === -1 ? null : story.path[focusedIndex]!;
  aside.append(
    renderTakesSection(story, focusedNode, focusedIndex, actions),
    renderFactsInForceSection(story, focusedIndex, actions),
    renderAsideSection(state, actions),
    renderAuthorsNoteSection(state, story, actions),
    renderAuthorBriefSection(state, story, actions),
    inspectorSection("context", "Context", state.requestContext === null ? 0 : 1, [renderRequestContext(state.requestContext)])
  );
  return aside;
}

function renderTakesSection(story: StoryPayload, focusedNode: StoryPathNode | null, focusedIndex: number, actions: RendererActions): HTMLElement {
  const partNumber = focusedIndex + 1;
  if (focusedNode === null) return inspectorSection("takes", "Takes", 0, [el("p", "empty-copy", "No part is focused yet.")]);
  const siblings = story.nodes.filter((candidate) => candidate.parentId === focusedNode.parentId && candidate.role !== "summary");
  const rows = siblings.map((sibling) => {
    const shown = sibling.id === focusedNode.id;
    const row = actionButton("take-row", "", () => actions.switchNode(sibling.id));
    row.classList.toggle("shown", shown);
    const tag = story.tags.find((candidate) => candidate.nodeId === rememberedLeafId(story, sibling.id));
    row.append(
      el("span", "take-row-marker", shown ? "●" : "○"),
      el("span", "take-row-preview", sibling.preview || "Untitled part"),
      el("span", "take-row-meta", `${sibling.childCount} ↓${tag === undefined ? "" : ` · ${tag.name}`}`)
    );
    return row;
  });
  return inspectorSection("takes", `Takes at ¶ ${partNumber}`, siblings.length, rows);
}

function renderFactsInForceSection(story: StoryPayload, focusedIndex: number, actions: RendererActions): HTMLElement {
  if (focusedIndex === -1 || story.facts.length === 0) {
    return inspectorSection("facts", "Facts in force", 0, [el("p", "empty-copy", "No Facts are in force here.")]);
  }
  const prefix = story.path.slice(0, focusedIndex + 1);
  const chips: HTMLElement[] = [];
  for (const fact of story.facts) {
    const effective = effectiveFactAtPath(fact, prefix);
    if (effective === null) continue;
    const chip = actionButton("chip wash", factLabel(fact), () => actions.setTab("facts"));
    chips.push(chip);
  }
  if (chips.length === 0) chips.push(el("p", "empty-copy", "No Facts are in force here."));
  return inspectorSection("facts", "Facts in force", chips.length, chips);
}

function renderAsideSection(state: RendererState, actions: RendererActions): HTMLElement {
  const asideQuestion = document.createElement("textarea");
  asideQuestion.className = "rail-textarea aside-question";
  asideQuestion.dataset.preserve = "aside-question";
  asideQuestion.value = state.drafts["aside-question"] ?? state.aside.question;
  asideQuestion.placeholder = "Ask about the manuscript…";
  asideQuestion.rows = 3;
  bindDraftInput(asideQuestion, () => actions.setDraft("aside-question", asideQuestion.value));
  const asideAction = state.aside.busy
    ? actionButton("aside-stop", "Stop", actions.stopAside)
    : actionButton("aside-ask", "Ask Aside", () => actions.askAside(asideQuestion.value));
  const asideControls = el("div", "aside-controls", asideAction, state.aside.answer.trim().length === 0 ? "" : actionButton("aside-use", "Use as line", actions.useAsideAnswer), state.aside.v2 ? "" : actionButton("aside-clear", "Clear", actions.clearAside));
  const content: HTMLElement[] = [asideQuestion, asideControls];
  let count = state.aside.notes.length;
  if (state.aside.v2) {
    const sessions = renderAsideSessions(state, actions);
    content.push(sessions);
    const session = state.aside.sessions.find((candidate) => candidate.id === state.aside.selectedSessionId);
    count = session?.turns.length ?? 0;
  } else if (state.aside.answer.length > 0) {
    content.push(el("p", "aside-answer", state.aside.answer));
  }
  return inspectorSection("aside", "Aside", count, content);
}

function renderAsideSessions(state: RendererState, actions: RendererActions): HTMLElement {
  const wrapper = el("div", "aside-sessions");
  const anchorPicker = document.createElement("select");
  anchorPicker.className = "aside-anchor-picker";
  anchorPicker.dataset.preserve = "aside-anchor-picker";
  anchorPicker.setAttribute("aria-label", "Aside history");
  const currentLeaf = state.story?.path.at(-1);
  const currentAnchor = currentLeaf === undefined
    ? null : { partId: currentLeaf.id, takeId: currentLeaf.id };
  const selectedKey = state.aside.anchor === null
    ? ASIDE_UNANCHORED_KEY : asideAnchorKey(state.aside.anchor);
  const currentKey = currentAnchor === null ? ASIDE_UNANCHORED_KEY : asideAnchorKey(currentAnchor);
  const anchorOptions: Array<{ readonly key: string; readonly label: string }> = [];
  if (currentAnchor !== null || state.aside.unanchoredCount === 0) {
    anchorOptions.push({
      key: ASIDE_CURRENT_KEY,
      label: currentAnchor === null ? "Current story · unanchored" : "Current story position"
    });
  }
  for (const anchor of state.aside.anchors) {
    const key = asideAnchorKey(anchor);
    if (currentAnchor !== null && key === currentKey) continue;
    const part = anchor.partNumber === undefined ? anchor.partId.slice(0, 8) : String(anchor.partNumber);
    const take = anchor.takeIndex === undefined || anchor.takeCount === undefined
      ? "take ?" : `take ${anchor.takeIndex}/${anchor.takeCount}`;
    anchorOptions.push({ key, label: `Part ${part} · ${take} · ${anchor.sessionCount} session${anchor.sessionCount === 1 ? "" : "s"}` });
  }
  if (state.aside.unanchoredCount > 0) {
    anchorOptions.push({
      key: ASIDE_UNANCHORED_KEY,
      label: `Unanchored · ${state.aside.unanchoredCount} session${state.aside.unanchoredCount === 1 ? "" : "s"}`
    });
  }
  if (selectedKey !== currentKey && !anchorOptions.some((entry) => entry.key === selectedKey)) {
    anchorOptions.push({
      key: selectedKey,
      label: state.aside.anchor === null
        ? "Selected unanchored history"
        : `Selected saved position · ${state.aside.anchor.partId.slice(0, 8)}`
    });
  }
  for (const entry of anchorOptions) {
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = entry.label;
    option.selected = entry.key === ASIDE_CURRENT_KEY ? selectedKey === currentKey : entry.key === selectedKey;
    anchorPicker.append(option);
  }
  anchorPicker.addEventListener("change", () => {
    actions.selectAsideAnchor(anchorPicker.value);
  });
  const picker = document.createElement("select");
  picker.className = "aside-session-picker";
  picker.dataset.preserve = "aside-session-picker";
  picker.setAttribute("aria-label", "Aside session");
  const newOption = document.createElement("option");
  newOption.value = "";
  newOption.textContent = "New session";
  newOption.selected = state.aside.selectedSessionId === null;
  picker.append(newOption);
  for (const session of state.aside.sessions) {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = session.title || "Untitled session";
    option.selected = session.id === state.aside.selectedSessionId;
    picker.append(option);
  }
  picker.addEventListener("change", () => {
    actions.selectAsideSession(picker.value);
  });
  wrapper.append(el("label", "aside-anchor-label", "History", anchorPicker), el("label", "aside-session-label", "Session", picker));
  const session = state.aside.sessions.find((candidate) => candidate.id === state.aside.selectedSessionId);
  const lastAnswer = session?.turns.at(-1)?.a;
  if (state.aside.answer.length > 0 && (state.aside.busy || state.aside.answer !== lastAnswer)) {
    wrapper.append(el("p", "aside-answer aside-live-answer", state.aside.answer));
  }
  if (session === undefined) {
    wrapper.append(el("p", "aside-history", "No saved session at this story position yet."));
    return wrapper;
  }
  const turns = el("div", "aside-turns");
  session.turns.forEach((turn, index) => {
    const row = el("article", "aside-turn");
    row.dataset.preserve = `aside-turn:${session.id}:${index}`;
    row.append(el("p", "aside-question-line", turn.q), el("p", "aside-answer", turn.a));
    const controls = el("div", "aside-turn-controls");
    controls.append(actionButton("aside-delete-turn", "Delete", () => actions.deleteAsideTurn(index)));
    if (index < session.turns.length - 1) controls.append(actionButton("aside-reset-turn", "Reset here", () => actions.resetAside(index)));
    if (index === session.turns.length - 1) controls.append(actionButton("aside-retake", "Retake", () => actions.retakeAside(index)));
    row.append(controls);
    turns.append(row);
  });
  wrapper.append(turns, actionButton("aside-clear-session", "Clear session", actions.clearAsideSession));
  return wrapper;
}

function renderAuthorsNoteSection(state: RendererState, story: StoryPayload, actions: RendererActions): HTMLElement {
  const note = document.createElement("textarea");
  note.className = "rail-textarea";
  note.dataset.preserve = "authors-note";
  note.value = state.drafts["authors-note"] ?? story.authorsNote ?? "";
  note.placeholder = "A note for the next request…";
  note.rows = 4;
  bindDraftInput(note, () => actions.setDraft("authors-note", note.value));
  const noteDepth = document.createElement("input");
  noteDepth.type = "number";
  noteDepth.min = "1";
  noteDepth.max = "100";
  noteDepth.step = "1";
  noteDepth.value = state.drafts["authors-note-depth"] ?? String(story.authorsNoteDepth ?? 1);
  noteDepth.dataset.preserve = "authors-note-depth";
  noteDepth.setAttribute("aria-label", "Author's Note depth");
  bindDraftInput(noteDepth, () => actions.setDraft("authors-note-depth", noteDepth.value));
  const noteSave = actionButton("note-save", "Save note", () => {
    const depth = Number(noteDepth.value);
    actions.setAuthorsNote(note.value, Number.isSafeInteger(depth) && depth > 0 ? depth : undefined);
  });
  const noteDepthField = el("label", "note-depth-field", "depth", noteDepth);
  const count = (state.drafts["authors-note"] ?? story.authorsNote ?? "").trim().length === 0 ? 0 : 1;
  return inspectorSection("authors-note", "Author's Note", count, [note, noteDepthField, noteSave]);
}

function renderAuthorBriefSection(state: RendererState, story: StoryPayload, actions: RendererActions): HTMLElement {
  const brief = document.createElement("textarea");
  brief.className = "rail-textarea";
  brief.dataset.preserve = "author-brief";
  brief.value = state.drafts["author-brief"] ?? story.authorBrief ?? "";
  brief.placeholder = "A brief for this story…";
  brief.rows = 3;
  bindDraftInput(brief, () => actions.setDraft("author-brief", brief.value));
  const briefSave = actionButton("brief-save", "Save brief", () => actions.setAuthorBrief(brief.value));
  const count = (state.drafts["author-brief"] ?? story.authorBrief ?? "").trim().length === 0 ? 0 : 1;
  return inspectorSection("author-brief", "Author Brief", count, [brief, briefSave]);
}
