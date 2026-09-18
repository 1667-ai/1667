/** The manuscript (Write, ⌘2): parts at the 660 measure with a 150 gutter
 * (D-09/D-10), the hover toolbar (D-11), the take gauge (D-13), and the
 * streaming part. The composer lives in `renderer-composer-view.ts`. */
import type { NodeStub, StoryPathNode, StoryPayload } from "../shared/types.js";
import { imageAttachmentLabel, imageMediaTypeLabel } from "../shared/image-attachment.js";
import { continuationStats, rememberedLeafId } from "../shared/story-model.js";
import { REFERENCE_BINDINGS, type ReferenceBinding } from "../tui/src/reference-bindings.js";
import {
  buildDesktopCommandContext,
  commandById,
  type DesktopCommandContext
} from "./renderer-commands.js";
import { actionButton, bindDraftInput, el, resizeTextarea } from "./renderer-dom.js";
import {
  effectiveFocusedPartId,
  storyChapterInfo,
  storyChapters,
  type RendererActions,
  type RendererState,
  type TextSelection
} from "./renderer-model.js";
import { renderComposer } from "./renderer-composer-view.js";
import { renderBraid } from "./renderer-braid-view.js";

/** A selection captured on a toolbar or menu verb's `mousedown`, before the
 * click could steal focus (and the browser selection with it) away from the
 * prose or the textarea. Module state, not `RendererState` — purely a
 * transient input detail, mirroring the collapsed-sections cache in
 * `renderer-inspector-view.ts`. */
let capturedSelection: { readonly partId: string; readonly selection: TextSelection } | null = null;

export function renderWriting(story: StoryPayload, state: RendererState, actions: RendererActions): HTMLElement {
  const writing = el("div", "writing-layout");
  const manuscript = el("div", "manuscript");
  let previousChapter = -1;
  const chapters = storyChapters(story);
  story.path.forEach((node, index) => {
    const chapter = chapters.find((candidate) => candidate.parts.some((part) => part.id === node.id));
    const chapterNumber = chapter?.number ?? storyChapterInfo(story, node).number;
    const chapterTitle = chapter?.title.trim() || storyChapterInfo(story, node).title;
    if (chapterNumber !== previousChapter) {
      manuscript.append(el("div", "chapter-rule", el("span", "chapter-number", `Chapter ${chapterNumber}`), el("span", "chapter-name", chapterTitle)));
      previousChapter = chapterNumber;
    }
    manuscript.append(renderPart(story, state, node, index, actions));
  });
  if (story.path.length === 0) manuscript.append(el("div", "empty-manuscript", "The page is blank. Start with a direction or write the first line yourself."));
  if (state.stream !== null) manuscript.append(renderStream(state.stream, actions));
  const braid = renderBraid(story, state, actions);
  writing.append(manuscript, ...(braid === null ? [] : [braid]), renderComposer(state, actions));
  return writing;
}

function renderPart(story: StoryPayload, state: RendererState, node: StoryPathNode, index: number, actions: RendererActions): HTMLElement {
  const focused = node.id === effectiveFocusedPartId(state, story);
  const editing = state.editingPartId === node.id;
  const draft = state.drafts[`part:${node.id}`];
  const dirty = draft !== undefined && draft !== node.text;
  const siblings = story.nodes.filter((candidate) => candidate.parentId === node.parentId && candidate.role !== "summary");
  const classes = [
    "manuscript-part",
    node === story.path.at(-1) ? "active" : "",
    focused ? "focused" : "dim",
    node.human === true ? "human" : "",
    node.role === "summary" ? "summary" : "",
    dirty ? "dirty" : ""
  ].filter(Boolean).join(" ");
  const article = el("article", classes);
  article.dataset.preserve = `part-card:${node.id}`;
  article.append(renderPartGutter(story, state, node, index, siblings, actions));
  article.append(renderPartBody(story, state, node, index, editing, draft, actions));
  return article;
}

function renderPartGutter(
  story: StoryPayload,
  state: RendererState,
  node: StoryPathNode,
  index: number,
  siblings: readonly NodeStub[],
  actions: RendererActions
): HTMLElement {
  const gutter = el("div", "part-gutter");
  const focused = node.id === effectiveFocusedPartId(state, story);
  const draft = state.drafts[`part:${node.id}`];
  const dirty = draft !== undefined && draft !== node.text;
  const waymark = `¶ ${index + 1}${siblings.length > 1 ? ` ×${siblings.length}` : ""}`;
  // R-06: the gutter reads as one --type-meta line at rest — the human/edit
  // pencil shares that line (revealed on hover or focus, see renderer.css)
  // instead of adding a permanent second row.
  const dirtyMark = el("span", "part-gutter-dirty", "✎");
  dirtyMark.hidden = !(node.human === true || dirty);
  gutter.append(el("div", "part-gutter-line", el("span", "part-gutter-waymark", waymark), dirtyMark));
  if (node.role === "summary") gutter.append(el("span", "part-gutter-summary", "◈"));
  if (!focused) return gutter;
  const siblingIndex = siblings.findIndex((candidate) => candidate.id === node.id);
  if (siblings.length > 1 && siblingIndex !== -1) {
    const previous = actionButton("part-take-previous", "‹", () => {
      const target = siblings[siblingIndex - 1];
      if (target !== undefined) actions.switchNode(target.id);
    });
    previous.disabled = siblingIndex <= 0;
    const next = actionButton("part-take-next", "›", () => {
      const target = siblings[siblingIndex + 1];
      if (target !== undefined) actions.switchNode(target.id);
    });
    next.disabled = siblingIndex >= siblings.length - 1;
    gutter.append(el("div", "part-gutter-take", previous, el("span", "part-take-count", `take ${siblingIndex + 1}/${siblings.length}`), next));
    gutter.append(renderTakeGauge(siblings, node.id, actions));
  }
  const directionToggle = actionButton("part-direction-toggle", "» direction", () => {
    const ctx = buildDesktopCommandContext(state, actions, null);
    const command = commandById("desktop.toggle-directions");
    if (command !== undefined && command.available(ctx)) command.run(ctx);
  });
  directionToggle.setAttribute("aria-pressed", String(state.showDirections));
  gutter.append(directionToggle);
  return gutter;
}

/** D-13 take gauge: spaced dots to 6, condensed dots to 12, a positional
 * track beyond that. The counter (`take j/k`, in the gutter above) is the
 * truth; this is only ever the shape. */
function renderTakeGauge(siblings: readonly NodeStub[], currentId: string, actions: RendererActions): HTMLElement {
  const count = siblings.length;
  const sizeClass = count <= 6 ? "spaced" : count <= 12 ? "condensed" : "track";
  const gauge = el("div", `take-gauge ${sizeClass}`);
  if (sizeClass === "track") {
    const track = el("div", "take-gauge-track");
    const currentIndex = Math.max(0, siblings.findIndex((sibling) => sibling.id === currentId));
    const marker = el("button", "take-gauge-track-marker");
    marker.type = "button";
    marker.style.left = `${(currentIndex / Math.max(1, count - 1)) * 100}%`;
    track.addEventListener("click", (event) => {
      const rect = track.getBoundingClientRect();
      const ratio = rect.width === 0 ? 0 : (event.clientX - rect.left) / rect.width;
      const target = siblings[Math.round(ratio * (count - 1))];
      if (target !== undefined) actions.switchNode(target.id);
    });
    track.append(marker);
    gauge.append(track);
    return gauge;
  }
  for (const sibling of siblings) {
    const dot = actionButton("take-gauge-dot", "", () => actions.switchNode(sibling.id));
    dot.classList.toggle("shown", sibling.id === currentId);
    dot.setAttribute("aria-label", sibling.id === currentId ? "Shown take" : "Switch to this take");
    gauge.append(dot);
  }
  return gauge;
}

function renderPartBody(
  story: StoryPayload,
  state: RendererState,
  node: StoryPathNode,
  index: number,
  editing: boolean,
  draft: string | undefined,
  actions: RendererActions
): HTMLElement {
  const body = el("div", "part-body");
  if (node.role === "summary") {
    const words = node.text.split(/\s+/u).filter(Boolean).length;
    body.append(el("div", "part-summary-header", `§ SUMMARY · ${words.toLocaleString()} words`));
  }
  const instruction = node.instruction.trim();
  if (state.showDirections && instruction.length > 0) body.append(el("p", "part-instruction", instruction));
  if (editing) {
    body.append(renderPartEditor(node, draft, actions));
  } else {
    const prose = el("div", "part-prose", draft ?? node.text);
    prose.setAttribute("aria-label", `Part ${index + 1}`);
    if (node.id !== effectiveFocusedPartId(state, story)) {
      prose.addEventListener("click", () => actions.focusPart(node.id));
    }
    prose.addEventListener("dblclick", () => actions.editPart(node.id));
    body.append(prose);
    body.append(renderPartToolbar(story, state, node, prose, actions));
  }
  if (node.imageAttachments !== undefined) {
    const images = el("div", "part-images", el("span", "eyebrow", "Attached images"));
    node.imageAttachments.forEach((image, imageIndex) => {
      images.append(el("span", "image-chip", `${imageAttachmentLabel(imageIndex)} · ${imageMediaTypeLabel(image.mediaType)} · ${image.width}×${image.height}`));
    });
    body.append(images);
  }
  return body;
}

function renderPartEditor(node: StoryPathNode, draft: string | undefined, actions: RendererActions): HTMLElement {
  const text = document.createElement("textarea");
  text.className = "part-text";
  text.value = draft ?? node.text;
  text.rows = Math.max(4, Math.min(18, text.value.split("\n").length + 1));
  text.setAttribute("aria-label", "Edit this part");
  text.dataset.preserve = `part:${node.id}`;
  bindDraftInput(text, () => {
    actions.setDraft(`part:${node.id}`, text.value);
    resizeTextarea(text);
  });
  queueMicrotask(() => resizeTextarea(text));
  const row = el("div", "part-edit-row",
    actionButton("part-save", "Save edit ⌘S", () => actions.editNode(node, text.value)),
    actionButton("part-save-take", "Save as take", () => actions.saveEditedTake(node, text.value)),
    actionButton("part-edit-direction", "Edit direction", () => actions.editNodeDirection(node)),
    actionButton("part-discard", "Discard", () => { actions.setDraft(`part:${node.id}`, undefined); actions.editPart(null); })
  );
  return el("div", "part-editor", text, row);
}

/** Captures a `TextSelection` from `window.getSelection()` inside a single
 * `.part-prose` text node — the prose renders the part's literal text with
 * no markup, so a Range boundary's character offset there is already the
 * offset into `node.text`. */
function proseSelection(prose: HTMLElement, node: StoryPathNode): TextSelection | undefined {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  if (!prose.contains(range.commonAncestorContainer)) return undefined;
  if ((prose.textContent ?? "") !== node.text) return undefined;
  const preRange = document.createRange();
  preRange.selectNodeContents(prose);
  preRange.setEnd(range.startContainer, range.startOffset);
  const start = preRange.toString().length;
  const end = start + range.toString().length;
  if (end <= start) return undefined;
  return { start, end, expected: node.text.slice(start, end) };
}

function renderPartToolbar(story: StoryPayload, state: RendererState, node: StoryPathNode, prose: HTMLElement, actions: RendererActions): HTMLElement {
  const toolbar = el("div", "part-toolbar");
  const run = (id: string, binding: ReferenceBinding | null = null, selection?: TextSelection): void => {
    actions.focusPart(node.id);
    const ctx = buildDesktopCommandContext(state, actions, binding, { focusOverride: node, selection });
    const command = commandById(id);
    if (command !== undefined && command.available(ctx)) command.run(ctx);
  };
  const busyTitle = "Writing… · esc stops";
  const retake = actionButton("part-retake", "Retake", () => run("take.retake"), undefined, "r");
  retake.disabled = state.stream !== null;
  if (retake.disabled) retake.title = busyTitle;
  const rewrite = actionButton("part-rewrite", "Rewrite", () => run("take.rewrite", null, capturedSelectionFor(node.id)));
  rewrite.addEventListener("mousedown", (event) => { event.preventDefault(); captureSelection(node, prose, state); });
  rewrite.disabled = state.stream !== null;
  if (rewrite.disabled) rewrite.title = busyTitle;
  const direct = actionButton("part-direct", "Direct", () => run("take.compose", REFERENCE_BINDINGS.navComposeI), undefined, "i");
  const tag = story.tags.find((candidate) => candidate.nodeId === rememberedLeafId(story, node.id));
  const tagButton = actionButton("part-tag", tag === undefined ? "Tag" : `tag: ${tag.name}`, () => run("take.tag"), undefined, tag === undefined ? "t" : undefined);
  const more = actionButton("part-more", "···", () => actions.openPartMenu(node.id));
  more.setAttribute("aria-label", "More part actions");
  more.addEventListener("mousedown", (event) => { event.preventDefault(); captureSelection(node, prose, state); });
  toolbar.append(retake, rewrite, direct, tagButton, more);
  return toolbar;
}

function captureSelection(node: StoryPathNode, prose: HTMLElement, state: RendererState): void {
  const editingText = state.editingPartId === node.id
    ? document.querySelector<HTMLTextAreaElement>(`[data-preserve="part:${node.id}"]`)
    : null;
  const selection = editingText !== null
    ? textareaSelection(editingText, node)
    : proseSelection(prose, node);
  capturedSelection = selection === undefined ? null : { partId: node.id, selection };
}

function textareaSelection(text: HTMLTextAreaElement, node: StoryPathNode): TextSelection | undefined {
  const start = text.selectionStart ?? 0;
  const end = text.selectionEnd ?? start;
  if (end <= start || text.value !== node.text) return undefined;
  return { start, end, expected: text.value.slice(start, end) };
}

function capturedSelectionFor(partId: string): TextSelection | undefined {
  if (capturedSelection === null || capturedSelection.partId !== partId) return undefined;
  return capturedSelection.selection;
}

/** The `···` overflow menu (D-05 popover shell), rendered from `renderApp`
 * like the keys sheet and the palette. */
export function renderPartMenu(state: RendererState, actions: RendererActions, partId: string): HTMLElement | null {
  const story = state.story;
  const pathNode = story?.path.find((candidate) => candidate.id === partId);
  if (story === undefined || story === null || pathNode === undefined) return null;
  const outer = el("div", "popover part-menu");
  outer.setAttribute("role", "dialog");
  outer.setAttribute("aria-label", "Part actions");
  outer.addEventListener("click", (event) => { if (event.target === outer) actions.closePopover(); });
  const card = el("div", "popover-card part-menu-card");
  const tagged = story.tags.find((candidate) => candidate.nodeId === rememberedLeafId(story, partId));
  const selection = capturedSelectionFor(partId);
  const ctx: DesktopCommandContext = buildDesktopCommandContext(state, actions, null, { focusOverride: pathNode, selection });
  const run = (id: string): void => {
    const command = commandById(id);
    if (command !== undefined && command.available(ctx)) command.run(ctx);
    actions.closePopover();
  };
  const item = (className: string, label: string, id: string): HTMLButtonElement => {
    const button = actionButton(className, label, () => run(id));
    const command = commandById(id);
    if (command !== undefined && !command.available(ctx)) button.disabled = true;
    return button;
  };
  card.append(el("h2", "popover-title", "Part actions"));
  const copyDisabled = continuationStats(story, partId).parts === 0;
  const copy = item("part-copy", "Copy line below", "take.copy-line-below");
  if (copyDisabled) { copy.disabled = true; copy.title = "No continuation to copy"; }
  const summaryTake = item("summary-take", "Summary take", "take.summary-take");
  const pruneUnused = item("prune-unused", "Prune unused takes", "take.prune-unused");
  const deletePart = item("part-delete ember", "Delete part…", "take.delete-part");
  if (state.stream !== null) {
    for (const button of [summaryTake, pruneUnused, deletePart]) {
      button.disabled = true;
      button.title = "Writing… · esc stops";
    }
  }
  const list = el("div", "part-menu-list",
    item("part-cut", "Take from cut", "take.take-from-cut"),
    selection === undefined ? "" : item("part-fact-selection", "Fact from selection", "take.fact-from-selection"),
    item("part-fact-here", "New Fact here", "take.new-fact-here"),
    copy,
    state.lineClipboard === null ? "" : item("part-paste", "Paste below", "take.paste-below"),
    item("part-switch", "Write from here", "take.switch-line-here"),
    summaryTake,
    pruneUnused,
    tagged === undefined ? "" : item("part-untag", "Remove tag", "take.remove-tag"),
    item("part-inspect", "Inspect", "take.inspect-part"),
    deletePart
  );
  card.append(list);
  outer.append(card);
  return outer;
}

function renderStream(stream: NonNullable<RendererState["stream"]>, actions: RendererActions): HTMLElement {
  const article = el("article", "manuscript-part streaming stream-card");
  article.dataset.preserve = "stream-card";
  const gutter = el("div", "part-gutter",
    el("span", "part-gutter-waymark", "⟳ writing"),
    el("span", "part-gutter-hint", "esc stops"),
    actionButton("stream-stop", "Stop", actions.stopStream)
  );
  const text = el("p", "stream-text", el("span", "fresh", stream.text || ""), el("span", "caret"));
  const reasoning = document.createElement("details");
  reasoning.className = "stream-reasoning";
  reasoning.dataset.preserve = "stream:reasoning";
  reasoning.append(el("summary", "", "Thoughts"), el("p", "", stream.reasoning));
  reasoning.hidden = stream.reasoning.length === 0;
  const stopped = el("p", "stream-stopped", stream.stoppedText.length === 0 ? "" : `Stopped with ${stream.stoppedText.length.toLocaleString()} characters retained.`);
  stopped.hidden = stream.stoppedText.length === 0;
  const body = el("div", "part-body", text, reasoning, stopped);
  article.append(gutter, body);
  return article;
}
