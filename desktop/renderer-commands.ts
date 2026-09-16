/** One registry for keys, the command palette, and (later) the toolbar.
 * Every TUI action the desktop supports appears here exactly once, keyed by
 * the `(mode, action)` pair `resolveDesktopBinding` resolves to; a binding
 * whose action has no entry is ignored — never a toast. Palette-only verbs
 * (no key of their own) live in `renderer-commands-verbs.ts` and are merged
 * into the same table below. */
import type { NodeStub, StoryPathNode, StoryPayload } from "../shared/types.js";
import type { KeyAction } from "../tui/src/keys.js";
import { REFERENCE_BINDINGS, type ReferenceBinding, type ReferenceBindingId } from "../tui/src/reference-bindings.js";
import { expandInspectorSection } from "./renderer-inspector-view.js";
import {
  effectiveFocusedPartId,
  storyChapters,
  type ComposerMode,
  type DesktopCommandGroup,
  type RendererActions,
  type RendererState,
  type TextSelection
} from "./renderer-model.js";
import { VERB_COMMANDS } from "./renderer-commands-verbs.js";

export interface DesktopCommandContext {
  readonly state: RendererState;
  readonly actions: RendererActions;
  readonly story: StoryPayload | null;
  readonly focused: StoryPathNode | null;
  /** Alternate takes of the focused part. These come from `story.nodes`
   * (stubs), not `story.path` — only one take per parent is ever on the
   * active path at once, so the siblings live off it. */
  readonly siblings: readonly NodeStub[];
  /** The literal binding that triggered this run, or `null` from the palette
   * or a click — only the `compose` command reads it (`i` sets Direct mode,
   * plain `enter` does not). */
  readonly binding: ReferenceBinding | null;
  /** A selection captured on `mousedown`, before a toolbar click could steal
   * it (D-11 Rewrite / Take from cut / Fact from selection). Undefined for
   * every keyboard- or palette-triggered run, which then apply to the whole
   * part. */
  readonly selection?: TextSelection;
  readonly focusComposer: (mode?: ComposerMode) => void;
  readonly focusInspectorSection: (key: string) => void;
  readonly toast: (text: string) => void;
}

export interface DesktopCommand {
  readonly id: string;
  readonly group: DesktopCommandGroup;
  readonly label: string;
  readonly binding?: ReferenceBindingId;
  readonly chord?: string;
  /** Gates both execution (a key or click that resolves to this command does
   * nothing when false) and palette listing. */
  readonly available: (ctx: DesktopCommandContext) => boolean;
  /** Navigation mechanics (arrows, page scroll, take switching) are real,
   * available commands — they just are not verbs a writer would search for,
   * so they stay off the palette even while `available` is true. */
  readonly hideFromPalette?: boolean;
  readonly run: (ctx: DesktopCommandContext) => void;
  /** The `(mode, action)` pair this command answers to from the TUI keymap.
   * Absent for palette-only verbs that have no key of their own. */
  readonly handles?: { readonly mode: "NAV" | "MAP"; readonly action: KeyAction };
}

export interface DesktopCommandContextOptions {
  /** Runs the command against this specific part instead of the state's
   * effectively-focused one — a D-11 toolbar verb always targets the part
   * whose toolbar it came from, even when the writer merely hovered it. */
  readonly focusOverride?: StoryPathNode;
  readonly selection?: TextSelection;
}

export function buildDesktopCommandContext(
  state: RendererState,
  actions: RendererActions,
  binding: ReferenceBinding | null,
  options: DesktopCommandContextOptions = {}
): DesktopCommandContext {
  const story = state.story;
  const focused = options.focusOverride ?? focusedNode(state, story);
  const siblings = story === null || focused === null
    ? []
    : story.nodes.filter((node) => node.parentId === focused.parentId && node.role !== "summary");
  return {
    state,
    actions,
    story,
    focused,
    siblings,
    binding,
    selection: options.selection,
    focusComposer: (mode) => focusComposer(state, actions, mode),
    focusInspectorSection: (key) => revealInspectorSection(key),
    toast: (text) => actions.toast(text)
  };
}

function focusedNode(state: RendererState, story: StoryPayload | null): StoryPathNode | null {
  if (story === null) return null;
  const id = effectiveFocusedPartId(state, story);
  return id === null ? null : story.path.find((node) => node.id === id) ?? null;
}

function focusComposer(state: RendererState, actions: RendererActions, mode?: ComposerMode): void {
  if (mode !== undefined) actions.setComposerMode(mode);
  if (state.tab !== "write") actions.setTab("write");
  document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
}

function revealInspectorSection(key: string): void {
  expandInspectorSection(key);
  document.querySelector<HTMLElement>(`[data-inspector-section="${key}"]`)?.scrollIntoView({ block: "nearest" });
}

function focusPart(ctx: DesktopCommandContext, id: string): void {
  ctx.actions.focusPart(id);
  document.querySelector<HTMLElement>(`[data-preserve="part-card:${id}"]`)?.scrollIntoView({ block: "nearest" });
}

function focusPathIndex(ctx: DesktopCommandContext, index: number): void {
  const target = ctx.story?.path[index];
  if (target !== undefined) focusPart(ctx, target.id);
}

function focusedPathIndex(ctx: DesktopCommandContext): number {
  if (ctx.story === null || ctx.focused === null) return -1;
  return ctx.story.path.findIndex((node) => node.id === ctx.focused!.id);
}

/** Continuing (Space) or a direct take from the composer targets the
 * focused part when it is not the leaf (review-fixes-2 #1), mirroring the
 * TUI's `continuationIntent` "from a seam": the new take is a child of the
 * focused part, not an extension of whatever the leaf currently is.
 * `undefined` at the leaf keeps today's append-at-the-leaf behaviour. */
function seamTarget(ctx: DesktopCommandContext): { readonly parentId: string } | undefined {
  const leaf = ctx.story?.path.at(-1);
  return ctx.focused !== null && leaf !== undefined && ctx.focused.id !== leaf.id
    ? { parentId: ctx.focused.id }
    : undefined;
}

function switchSiblingTake(ctx: DesktopCommandContext, direction: -1 | 1): void {
  if (ctx.focused === null || ctx.siblings.length < 2) return;
  const index = ctx.siblings.findIndex((node) => node.id === ctx.focused!.id);
  const target = ctx.siblings[index + direction];
  if (target !== undefined) ctx.actions.switchNode(target.id);
}

function focusChapter(ctx: DesktopCommandContext, direction: -1 | 1): void {
  const story = ctx.story;
  if (story === null) return;
  const chapters = storyChapters(story);
  const index = ctx.focused === null ? -1 : chapters.findIndex((chapter) =>
    chapter.parts.some((part) => part.id === ctx.focused!.id));
  const target = chapters[index + direction]?.parts[0];
  if (target !== undefined) focusPathIndex(ctx, story.path.findIndex((node) => node.id === target.id));
}

function scrollWorkspace(amount: number): void {
  document.querySelector<HTMLElement>(".workspace")?.scrollBy({ top: amount });
}

/** The map cursor (`state.mapCursorId`) defaults to the focused part until a
 * map-mode key first moves it. Cursor commands walk `story.nodes` — the same
 * flat list `renderMap` already draws from — not just the active line. */
function mapCursorNode(ctx: DesktopCommandContext): StoryPayload["nodes"][number] | null {
  const story = ctx.story;
  if (story === null) return null;
  // A cursor id can outlive the story it pointed into (review-fixes-2 #12):
  // treat one that names no node here the same as no cursor at all, rather
  // than going quietly dead.
  const cursorId = ctx.state.mapCursorId;
  const validCursorId = cursorId !== null && story.nodes.some((node) => node.id === cursorId) ? cursorId : null;
  const id = validCursorId ?? effectiveFocusedPartId(ctx.state, story);
  return id === null ? null : story.nodes.find((node) => node.id === id) ?? null;
}

function moveMapCursor(ctx: DesktopCommandContext, direction: -1 | 1): void {
  const story = ctx.story;
  if (story === null) return;
  const current = mapCursorNode(ctx);
  const index = current === null ? -1 : story.nodes.findIndex((node) => node.id === current.id);
  const target = story.nodes[index + direction];
  if (target !== undefined) ctx.actions.setMapCursor(target.id);
}

function moveMapCursorTake(ctx: DesktopCommandContext, direction: -1 | 1): void {
  const story = ctx.story;
  const current = mapCursorNode(ctx);
  if (story === null || current === null) return;
  const siblings = story.nodes.filter((node) => node.parentId === current.parentId && node.role !== "summary");
  const target = siblings[siblings.findIndex((node) => node.id === current.id) + direction];
  if (target !== undefined) ctx.actions.setMapCursor(target.id);
}

const hasStory = (ctx: DesktopCommandContext): boolean => ctx.story !== null;
const hasFocus = (ctx: DesktopCommandContext): boolean => ctx.focused !== null;
const idleFocus = (ctx: DesktopCommandContext): boolean => ctx.focused !== null && ctx.state.stream === null;

/** Navigation mechanics: real, runnable keys (shown in the keys sheet) but
 * not verbs a writer would search for, so every one hides from the palette
 * while staying just as available as the command it moves. */
const NAV_COMMANDS: readonly DesktopCommand[] = [
  {
    id: "nav.focus-previous", group: "Story", label: "Move focus up", binding: "navFocusPrevious",
    available: hasFocus, hideFromPalette: true, handles: { mode: "NAV", action: "focus-previous" },
    run: (ctx) => focusPathIndex(ctx, Math.max(0, focusedPathIndex(ctx) - 1))
  },
  {
    id: "nav.focus-next", group: "Story", label: "Move focus down", binding: "navFocusNext",
    available: hasFocus, hideFromPalette: true, handles: { mode: "NAV", action: "focus-next" },
    run: (ctx) => focusPathIndex(ctx, focusedPathIndex(ctx) + 1)
  },
  {
    id: "nav.take-previous", group: "Take", label: "Previous take", binding: "navTakePrevious",
    available: hasFocus, hideFromPalette: true, handles: { mode: "NAV", action: "take-previous" },
    run: (ctx) => switchSiblingTake(ctx, -1)
  },
  {
    id: "nav.take-next", group: "Take", label: "Next take", binding: "navTakeNext",
    available: hasFocus, hideFromPalette: true, handles: { mode: "NAV", action: "take-next" },
    run: (ctx) => switchSiblingTake(ctx, 1)
  },
  {
    id: "nav.scroll-up", group: "Story", label: "Scroll up a page", binding: "navPageUp",
    available: hasStory, hideFromPalette: true, handles: { mode: "NAV", action: "scroll-up" },
    run: () => scrollWorkspace(-document.querySelector(".workspace")!.clientHeight * 0.9)
  },
  {
    id: "nav.scroll-down", group: "Story", label: "Scroll down a page", binding: "navPageDown",
    available: hasStory, hideFromPalette: true, handles: { mode: "NAV", action: "scroll-down" },
    run: () => scrollWorkspace(document.querySelector(".workspace")!.clientHeight * 0.9)
  },
  {
    id: "nav.scroll-line-up", group: "Story", label: "Scroll up a line", binding: "navScrollLineUp",
    available: hasStory, hideFromPalette: true, handles: { mode: "NAV", action: "scroll-line-up" },
    run: () => scrollWorkspace(-32)
  },
  {
    id: "nav.scroll-line-down", group: "Story", label: "Scroll down a line", binding: "navScrollLineDown",
    available: hasStory, hideFromPalette: true, handles: { mode: "NAV", action: "scroll-line-down" },
    run: () => scrollWorkspace(32)
  },
  {
    id: "nav.top", group: "Story", label: "Jump to the first part", binding: "navTop",
    available: hasFocus, hideFromPalette: true, handles: { mode: "NAV", action: "top" },
    run: (ctx) => focusPathIndex(ctx, 0)
  },
  {
    id: "nav.leaf", group: "Story", label: "Jump to the last part", binding: "navLeaf",
    available: hasFocus, hideFromPalette: true, handles: { mode: "NAV", action: "leaf" },
    run: (ctx) => focusPathIndex(ctx, (ctx.story?.path.length ?? 1) - 1)
  },
  {
    id: "nav.chapter-previous", group: "Chapters", label: "Jump to the previous chapter", binding: "navChapterPrevious",
    available: hasFocus, hideFromPalette: true, handles: { mode: "NAV", action: "chapter-previous" },
    run: (ctx) => focusChapter(ctx, -1)
  },
  {
    id: "nav.chapter-next", group: "Chapters", label: "Jump to the next chapter", binding: "navChapterNext",
    available: hasFocus, hideFromPalette: true, handles: { mode: "NAV", action: "chapter-next" },
    run: (ctx) => focusChapter(ctx, 1)
  },
  {
    id: "map.focus-previous", group: "Map", label: "Move the map cursor up", binding: "mapFocusPrevious",
    available: hasStory, hideFromPalette: true, handles: { mode: "MAP", action: "focus-previous" },
    run: (ctx) => moveMapCursor(ctx, -1)
  },
  {
    id: "map.focus-next", group: "Map", label: "Move the map cursor down", binding: "mapFocusNext",
    available: hasStory, hideFromPalette: true, handles: { mode: "MAP", action: "focus-next" },
    run: (ctx) => moveMapCursor(ctx, 1)
  },
  {
    id: "map.take-previous", group: "Map", label: "Previous sibling take", binding: "mapPathTakePrevious",
    available: hasStory, hideFromPalette: true, handles: { mode: "MAP", action: "take-previous" },
    run: (ctx) => moveMapCursorTake(ctx, -1)
  },
  {
    id: "map.take-next", group: "Map", label: "Next sibling take", binding: "mapPathTakeNext",
    available: hasStory, hideFromPalette: true, handles: { mode: "MAP", action: "take-next" },
    run: (ctx) => moveMapCursorTake(ctx, 1)
  },
  {
    id: "map.apply", group: "Map", label: "Switch to this take", binding: "mapApply",
    available: hasStory, hideFromPalette: true, handles: { mode: "MAP", action: "apply" },
    run: (ctx) => {
      const node = mapCursorNode(ctx);
      if (node !== null) ctx.actions.switchNode(node.id);
      ctx.actions.setTab("write");
    }
  }
];

/** The manuscript's own verbs — every one keyed, most also in the palette. */
const TAKE_COMMANDS: readonly DesktopCommand[] = [
  {
    id: "take.continue", group: "Take", label: "Continue this part", binding: "navContinue",
    available: (ctx) => hasStory(ctx) && ctx.state.stream === null && ctx.state.stoppedGeneration === null,
    handles: { mode: "NAV", action: "continue" },
    run: (ctx) => ctx.actions.continueStory("continue", ctx.state.drafts.composer ?? "", seamTarget(ctx))
  },
  {
    id: "take.compose", group: "Take", label: "Focus the composer", binding: "navComposeEnter",
    available: hasStory, handles: { mode: "NAV", action: "compose" },
    run: (ctx) => ctx.focusComposer(ctx.binding?.name === "i" ? "direct" : undefined)
  },
  {
    id: "take.retake", group: "Take", label: "Retake this part", binding: "navRegenerate",
    available: idleFocus, handles: { mode: "NAV", action: "regenerate" },
    run: (ctx) => ctx.actions.retakeLine(ctx.focused!, { editDirection: false })
  },
  {
    id: "take.retake-with-prompt", group: "Take", label: "Retake with a new direction", binding: "navRetakeWithPrompt",
    available: idleFocus, handles: { mode: "NAV", action: "retake-with-prompt" },
    run: (ctx) => ctx.actions.retakeLine(ctx.focused!)
  },
  {
    id: "take.write", group: "Take", label: "Write a take myself", binding: "navWrite",
    available: hasStory, handles: { mode: "NAV", action: "write" },
    run: (ctx) => {
      // A sibling take of the focused part (review-fixes-2 #4), mirroring
      // the TUI's `w` — never a child of whatever the leaf happens to be.
      if (ctx.focused !== null) {
        ctx.actions.setComposerWriteTarget({ partId: ctx.focused.id, parentId: ctx.focused.parentId });
      }
      ctx.focusComposer("write");
    }
  },
  {
    id: "take.edit", group: "Take", label: "Edit this part", binding: "navEdit",
    available: hasFocus, handles: { mode: "NAV", action: "edit" },
    run: (ctx) => {
      if (ctx.state.tab !== "write") ctx.actions.setTab("write");
      ctx.actions.editPart(ctx.focused!.id);
      document.querySelector<HTMLTextAreaElement>(`[data-preserve="part:${ctx.focused!.id}"]`)?.focus();
    }
  },
  {
    id: "take.open-aside", group: "Take", label: "Ask Aside", binding: "navAside",
    available: hasStory, handles: { mode: "NAV", action: "open-aside" },
    run: (ctx) => {
      if (ctx.state.inspectorHidden) ctx.actions.setInspectorHidden(false);
      ctx.focusInspectorSection("aside");
      document.querySelector<HTMLTextAreaElement>(".aside-question")?.focus();
    }
  },
  {
    id: "take.copy-part", group: "Take", label: "Copy this part", binding: "navCopyPart",
    available: hasFocus, handles: { mode: "NAV", action: "copy-part" },
    run: (ctx) => {
      const index = focusedPathIndex(ctx) + 1;
      void navigator.clipboard.writeText(ctx.focused!.text)
        .then(() => ctx.toast(`Copied ¶ ${index}`))
        .catch(() => ctx.toast("Copy failed"));
    }
  },
  {
    id: "take.copy-line", group: "Take", label: "Copy the whole line", binding: "navCopyLine",
    available: hasStory, handles: { mode: "NAV", action: "copy-line" },
    run: (ctx) => {
      const parts = ctx.story!.path;
      void navigator.clipboard.writeText(parts.map((node) => node.text).join("\n\n"))
        .then(() => ctx.toast(`Copied the line · ${parts.length} ¶`))
        .catch(() => ctx.toast("Copy failed"));
    }
  },
  {
    id: "take.delete-part", group: "Take", label: "Delete this part", binding: "navPrune",
    available: hasFocus, handles: { mode: "NAV", action: "prune" },
    run: (ctx) => ctx.actions.deleteNode(ctx.focused!)
  },
  {
    id: "take.tag", group: "Take", label: "Tag this line", binding: "navTag",
    available: hasFocus, handles: { mode: "NAV", action: "tag" },
    run: (ctx) => ctx.actions.tagLine(ctx.focused!)
  },
  {
    id: "take.open-actions", group: "Take", label: "Actions for this part", binding: "navOpenActions",
    available: () => true, handles: { mode: "NAV", action: "open-actions" },
    run: (ctx) => ctx.actions.openPalette("Take")
  },
  {
    id: "take.toggle-thought", group: "Take", label: "Show this part's thought", binding: "navToggleThought",
    available: hasFocus, handles: { mode: "NAV", action: "toggle-thought" },
    run: (ctx) => {
      if (ctx.focused!.reasoning === true) {
        ctx.actions.inspect("reasoning", ctx.focused!);
        ctx.actions.setTab("inspect");
      } else ctx.toast(`No thought on ¶ ${focusedPathIndex(ctx) + 1}`);
    }
  },
  {
    id: "take.open-probs", group: "Take", label: "Show token alternatives", binding: "navOpenProbs",
    available: hasFocus, handles: { mode: "NAV", action: "open-probs" },
    run: (ctx) => {
      if (ctx.focused!.tokenProbabilities === true) {
        ctx.actions.inspect("probabilities", ctx.focused!);
        ctx.actions.setTab("inspect");
      } else ctx.toast(`No token alternatives on ¶ ${focusedPathIndex(ctx) + 1}`);
    }
  },
  {
    id: "take.open-records", group: "Take", label: "Show generation records", binding: "navOpenRecords",
    available: hasFocus, handles: { mode: "NAV", action: "open-records" },
    run: (ctx) => {
      if ((ctx.focused!.generationRecordCount ?? 0) > 0) {
        ctx.actions.inspect("records", ctx.focused!);
        ctx.actions.setTab("inspect");
      } else ctx.toast(`No generation records on ¶ ${focusedPathIndex(ctx) + 1}`);
    }
  },
  {
    id: "take.open-request", group: "Take", label: "Inspect the next request", binding: "navOpenRequest",
    available: () => true, handles: { mode: "NAV", action: "open-request" },
    run: () => {
      const details = document.querySelector<HTMLDetailsElement>(".request-details");
      if (details === null) return;
      details.open = true;
      details.tabIndex = 0;
      details.focus({ preventScroll: true });
      details.scrollIntoView({ block: "nearest" });
    }
  },
  {
    id: "take.toggle-context", group: "Take", label: "Show context details", binding: "navToggleContext",
    available: hasStory, handles: { mode: "NAV", action: "toggle-context-meter" },
    run: (ctx) => {
      if (ctx.state.inspectorHidden) ctx.actions.setInspectorHidden(false);
      ctx.focusInspectorSection("context");
    }
  }
];

const KEY_COMMANDS: readonly DesktopCommand[] = [...NAV_COMMANDS, ...TAKE_COMMANDS];

export const COMMANDS: readonly DesktopCommand[] = [...KEY_COMMANDS, ...VERB_COMMANDS];

const BY_MODE_ACTION = new Map<string, DesktopCommand>();
for (const command of COMMANDS) {
  if (command.handles !== undefined) BY_MODE_ACTION.set(`${command.handles.mode}:${command.handles.action}`, command);
}

export function commandForAction(action: KeyAction, mode: "NAV" | "MAP"): DesktopCommand | undefined {
  return BY_MODE_ACTION.get(`${mode}:${action}`);
}

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command] as const));

/** Looks a command up by its stable id — for a toolbar or menu verb with no
 * key of its own (Rewrite, Take from cut, Fact from selection, Inspect, …),
 * so the view can still run it through the registry instead of duplicating
 * its `run` logic. */
export function commandById(id: string): DesktopCommand | undefined {
  return BY_ID.get(id);
}

const SUPPORTED_BINDING_IDS: ReadonlySet<ReferenceBindingId> = new Set(
  COMMANDS.map((command) => command.binding).filter((id): id is ReferenceBindingId => id !== undefined)
);

const BINDING_ID_BY_OBJECT = new Map<ReferenceBinding, ReferenceBindingId>(
  (Object.entries(REFERENCE_BINDINGS) as [ReferenceBindingId, ReferenceBinding][]).map(([id, binding]) => [binding, id])
);

/** True when some command in the registry answers to this exact reference
 * binding object — used by the keys sheet to filter the TUI's own sections. */
export function registryHasBinding(binding: ReferenceBinding): boolean {
  const id = BINDING_ID_BY_OBJECT.get(binding);
  return id !== undefined && SUPPORTED_BINDING_IDS.has(id);
}
