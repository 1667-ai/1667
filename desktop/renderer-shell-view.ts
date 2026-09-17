import { rememberedLeafId } from "../shared/story-model.js";
import { actionButton, el } from "./renderer-dom.js";
import {
  activeLeaf,
  storyChapters,
  storyHasUnsavedDrafts,
  storyWordCount,
  type RendererActions,
  type RendererState,
  type RendererTab
} from "./renderer-model.js";

/** Titlebar D-01: brand, a truncating breadcrumb, and the always-visible
 * right-hand chips. No verbs live here besides the palette chip. */
export function renderTitlebar(state: RendererState, actions: RendererActions): HTMLElement {
  const header = el("header", "titlebar");
  const brand = el("div", "brand");
  const mark = document.createElement("img");
  mark.src = "../docs/assets/1667-rainbow.svg";
  mark.alt = "";
  mark.className = "brand-mark";
  brand.append(mark, el("span", "brand-word", "1667"));
  header.append(brand, renderBreadcrumb(state), renderTitlebarActions(state, actions));
  return header;
}

function renderBreadcrumb(state: RendererState): HTMLElement {
  const breadcrumb = el("div", "breadcrumb");
  const story = state.story;
  if (story === null) {
    breadcrumb.append(el("span", "breadcrumb-segment", destinationSummary(state)));
    return breadcrumb;
  }
  breadcrumb.append(el("span", "story-title", story.title));
  const leaf = activeLeaf(story);
  const lineTag = leaf === null ? undefined : story.tags.find((tag) => tag.nodeId === rememberedLeafId(story, leaf.id));
  if (lineTag !== undefined) {
    breadcrumb.append(el("span", "breadcrumb-sep", "·"), el("span", "breadcrumb-segment", `⚑ ${lineTag.name}`));
  }
  breadcrumb.append(el("span", "breadcrumb-sep", "·"), el("span", "breadcrumb-segment", destinationSummary(state)));
  return breadcrumb;
}

function destinationSummary(state: RendererState): string {
  const story = state.story;
  if (state.tab === "write") {
    if (story === null) return "Write";
    const leaf = activeLeaf(story);
    const partNumber = leaf === null ? 0 : story.path.findIndex((node) => node.id === leaf.id) + 1;
    const siblings = leaf === null ? [] : story.nodes.filter((node) => node.parentId === leaf.parentId && node.role !== "summary");
    const takeIndex = leaf === null ? 0 : siblings.findIndex((node) => node.id === leaf.id) + 1;
    return `¶ ${partNumber} of ${story.path.length} · take ${takeIndex} of ${Math.max(siblings.length, 1)} · ${storyWordCount(story).toLocaleString()} words`;
  }
  if (state.tab === "library") return `Library · ${state.stories.length} stor${state.stories.length === 1 ? "y" : "ies"}`;
  if (story === null) return destinationLabel(state.tab);
  if (state.tab === "facts") return `Facts · ${story.facts.length} fact${story.facts.length === 1 ? "" : "s"}`;
  if (state.tab === "chapters") return `Chapters · ${storyChapters(story).length} chapter${storyChapters(story).length === 1 ? "" : "s"} · ${story.path.length} ¶`;
  if (state.tab === "settings") {
    const revision = state.settings?.activeRevision;
    const pending = state.settings?.pendingRevision ?? null;
    return `Settings${revision === undefined || revision === null ? "" : ` · revision ${revision}`}${pending === null ? "" : " · pending"}`;
  }
  return destinationLabel(state.tab);
}

function destinationLabel(tab: RendererTab): string {
  if (tab === "map") return "Map";
  if (tab === "inspect") return "Inspect";
  if (tab === "chapters") return "Chapters";
  if (tab === "facts") return "Facts";
  if (tab === "settings") return "Settings";
  if (tab === "library") return "Library";
  return "Write";
}

function renderTitlebarActions(state: RendererState, actions: RendererActions): HTMLElement {
  const box = el("div", "titlebar-actions");
  const story = state.story;
  if (story !== null) {
    const dirty = state.stream === null && storyHasUnsavedDrafts(story, state);
    const saveClass = state.stream === null ? (dirty ? "dirty" : "saved") : "streaming";
    const saveLabel = state.stream === null ? (dirty ? "unsaved edits" : "saved") : "writing…";
    box.append(el("span", `story-save-state ${saveClass}`, saveLabel));
  }
  box.append(actionButton("palette-chip", "⌘K", () => actions.openPalette(), "Command palette"));
  box.append(el("span", `connection-chip ${state.connection}`, state.connection));
  return box;
}

interface RailEntry {
  readonly tab: RendererTab;
  readonly glyph: string;
  readonly label: string;
  readonly shortcut: string;
}

const RAIL_ENTRIES: readonly RailEntry[] = [
  { tab: "library", glyph: "≡", label: "Library", shortcut: "⌘1" },
  { tab: "write", glyph: "¶", label: "Write", shortcut: "⌘2" },
  { tab: "facts", glyph: "F", label: "Facts", shortcut: "⌘3" },
  { tab: "chapters", glyph: "§", label: "Chapters", shortcut: "⌘4" },
  { tab: "map", glyph: "⑂", label: "Map", shortcut: "⌘5" },
  { tab: "inspect", glyph: "⊙", label: "Inspect", shortcut: "⌘6" }
];

const SETTINGS_ENTRY: RailEntry = { tab: "settings", glyph: ",", label: "Settings", shortcut: "⌘," };

/** Destination rail D-02: icons only, fixed order, Settings pinned bottom. */
export function renderRail(state: RendererState, actions: RendererActions): HTMLElement {
  const rail = el("nav", "rail");
  const top = el("div", "rail-group");
  for (const entry of RAIL_ENTRIES) top.append(renderRailButton(entry, state, actions));
  const bottom = el("div", "rail-group rail-group-bottom", renderRailButton(SETTINGS_ENTRY, state, actions));
  rail.append(top, bottom);
  return rail;
}

function renderRailButton(entry: RailEntry, state: RendererState, actions: RendererActions): HTMLButtonElement {
  const button = actionButton(`tab-${entry.tab}`, entry.glyph, () => actions.setTab(entry.tab));
  button.classList.toggle("active", state.tab === entry.tab);
  button.setAttribute("aria-label", `${entry.label} ${entry.shortcut}`);
  button.title = `${entry.label} ${entry.shortcut}`;
  if (railHasAttention(entry.tab, state)) button.append(el("span", "attention"));
  return button;
}

function railHasAttention(tab: RendererTab, state: RendererState): boolean {
  if (tab === "facts") {
    const run = state.factConsistency;
    if (run === null || state.factConsistencySeen) return false;
    return run.parts.some((part) => part.findings.length > 0);
  }
  if (tab === "settings") return state.settings?.pendingRevision !== null && state.settings?.pendingRevision !== undefined;
  if (tab === "library") return state.updater?.state === "available" || state.updater?.state === "downloaded";
  return false;
}

/** D-38 toast and D-39 banner, stacked bottom-left over the gutter. No
 * timeout; the app clears them on the next keydown or click elsewhere. */
export function renderFeedbackStack(state: RendererState): HTMLElement {
  const stack = el("div", "feedback-stack");
  if (state.error !== null) stack.append(el("div", "error-banner", state.error));
  const toast = el("div", "toast", state.status);
  toast.title = state.status;
  toast.setAttribute("aria-live", "polite");
  stack.append(toast);
  return stack;
}

/** The toast and error banner change on almost every action. Update them in
 * place instead of doing a full re-render, so an incidental status change
 * never disturbs unrelated DOM (a <details> mid-toggle, a focused control
 * with no data-preserve key). */
export function updateFeedbackDom(root: HTMLElement, state: RendererState): void {
  const toast = root.querySelector<HTMLElement>(".toast");
  if (toast !== null) {
    toast.textContent = state.status;
    toast.title = state.status;
  }
  const stack = root.querySelector<HTMLElement>(".feedback-stack");
  const banner = root.querySelector<HTMLElement>(".error-banner");
  if (state.error === null) {
    banner?.remove();
  } else if (banner !== null) {
    banner.textContent = state.error;
  } else if (stack !== null) {
    const created = document.createElement("div");
    created.className = "error-banner";
    created.textContent = state.error;
    stack.prepend(created);
  }
}

/** Clears the toast/error banner on the next keydown or click elsewhere.
 * Deferred to a microtask so it never interrupts that same event's own
 * native default action, and never clobbers a fresh status the same click's
 * own handler just set. */
export function createFeedbackClearHandler(
  getState: () => Pick<RendererState, "status" | "error">,
  clearStaleFeedback: (previousStatus: string, previousError: string | null) => void
): (event: Event) => void {
  return (event) => {
    const target = event.target instanceof Element ? event.target.closest(".toast, .error-banner") : null;
    if (target !== null) return;
    const previousStatus = getState().status;
    const previousError = getState().error;
    if (previousStatus === "" && previousError === null) return;
    queueMicrotask(() => clearStaleFeedback(previousStatus, previousError));
  };
}
