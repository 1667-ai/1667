import { continuationStats, createStoryIndex, rememberedLeafId } from "../../shared/story-model.js";
import { TAG_STATUSES, type StoryNode } from "../../shared/types.js";
import type { AppSource } from "./app.js";
import { openFactFromSelection, openPartEditor } from "./editor-action.js";
import { applyTextKey, type ResolvedKey } from "./keys.js";
import { copyToClipboard } from "./clipboard.js";
import { pasteClipboardIntoComposer } from "./compose-clipboard.js";
import { composerSurfaceAction } from "./composer-surface-action.js";
import { composerPageRows } from "./composer-viewport.js";
import { composerMotion } from "./composer-motion.js";
import { directComposerWrapWidth } from "./composer-geometry.js";
import { copyStoryText } from "./copy-actions.js";
import { recordHumanWords, saveConfig } from "./config.js";
import { rememberFocus } from "./reading-position-persist.js";
import { openMap } from "./map-actions.js";
import { createNewStory } from "./library-actions.js";
import { resolveRerouteTarget } from "./path-layout.js";
import {
  insertComposerText,
  setComposerText
} from "./composer-model.js";
import {
  capturePendingDirectDraft,
  claimDirectComposer,
  openDirectComposer,
  openRetakeComposer,
  resumeDirectComposer,
  resumeRetakeComposer,
  suspendRetakeComposer
} from "./composer-ownership.js";
import { countWords } from "../../shared/story-text.js";
import { draftImagesFor, removeDraftImageAt } from "./draft-image.js";
import { humanWordsOf } from "./rail.js";
import {
  createStoryViewModel,
  lastPartRowIndex,
  rowIndexForNode,
  rowPart,
  type StoryViewModel
} from "./model.js";
import { createBreakAtFocus, jumpAdjacentChapter } from "./chapter-actions.js";
import { partHasThought } from "./reasoning-model.js";
import { ensureThoughtLoaded } from "./reasoning-actions.js";
import { generate, generationBusy } from "./generation-action.js";
import {
  partActionRequiresPersistedTarget,
  partActions,
  type PartAction,
  type PartActionId,
  type PartActionSelection
} from "./part-actions.js";
import { createPrunePlan } from "./prune-model.js";
import type { PendingGenerationDraft, RuntimeState } from "./state.js";
import { canRewriteSelection, type StorySelectionSpan } from "./selection-projection.js";
import type { ActionContext } from "./action-context.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { openRewriteComposer, resolveRewriteTarget, submitRewriteComposer } from "./rewrite-action.js";
import {
  advanceOrSaveTag,
  confirmPrune,
  removeTag,
  switchTake,
  switchTakeAt,
  undoChapterBreakChange
} from "./story-mutations.js";
import {
  followStoryViewport,
  pinStoryViewport,
  scrollStoryViewport
} from "./viewport-intent.js";

export type { ActionContext } from "./action-context.js";

export {
  generate,
  generationBusy,
  requestGenerationStop,
  restorePendingGenerationDraft,
  restoreStoppedGenerationDraft
} from "./generation-action.js";

/** NAV-mode actions (plus quit, which only NAV reaches). */
export async function navAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  requestQuit: () => void
): Promise<void> {
  const view = createStoryViewModel(state.payload, state.stream);
  const count = view.rows.length;
  const SCROLL_STEP = 8;
  if (state.chapterDeleteArmedId !== null && resolved.action !== "prune") {
    state.chapterDeleteArmedId = null;
    if (resolved.action === "cancel") return void (state.toast = "chapter break kept");
  }
  if (resolved.action === "scroll-down") scrollStoryViewport(state, SCROLL_STEP);
  else if (resolved.action === "scroll-up") scrollStoryViewport(state, -SCROLL_STEP);
  else if (resolved.action === "scroll-line-down") scrollStoryViewport(state, 1);
  else if (resolved.action === "scroll-line-up") scrollStoryViewport(state, -1);
  else if (resolved.action === "focus-next") {
    state.focusIndex = Math.min(count - 1, state.focusIndex + 1);
    followStoryViewport(state);
    rememberFocus(state, source);
    queueThoughtLoad(state, source, context, view);
  }
  else if (resolved.action === "focus-index") {
    state.focusIndex = Math.max(0, Math.min(count - 1, resolved.index ?? state.focusIndex));
    followStoryViewport(state);
    rememberFocus(state, source);
    queueThoughtLoad(state, source, context, view);
  }
  else if (resolved.action === "focus-previous") {
    state.focusIndex = Math.max(0, state.focusIndex - 1);
    followStoryViewport(state);
    rememberFocus(state, source);
    queueThoughtLoad(state, source, context, view);
  }
  else if (resolved.action === "top") {
    state.focusIndex = 0;
    pinStoryViewport(state, 0);
    rememberFocus(state, source);
    queueThoughtLoad(state, source, context, view);
  }
  else if (resolved.action === "leaf") {
    state.focusIndex = lastPartRowIndex(view);
    followStoryViewport(state);
    rememberFocus(state, source);
    queueThoughtLoad(state, source, context, view);
  }
  else if (resolved.action === "toggle-instructions") state.showInstructions = !state.showInstructions;
  else if (resolved.action === "toggle-prompt") {
    const index = Math.max(0, Math.min(count - 1, resolved.index ?? state.focusIndex));
    const part = rowPart(view, index);
    if (part !== null) {
      state.focusIndex = index;
      followStoryViewport(state);
      rememberFocus(state, source);
      const expanded = new Set(state.expandedPromptIds);
      if (expanded.has(part.id)) expanded.delete(part.id);
      else expanded.add(part.id);
      state.expandedPromptIds = expanded;
    }
  }
  else if (resolved.action === "toggle-thought") {
    // Keyboard `T` always names the focused row (no `resolved.index`); a
    // click on another part's own waymark carries that part's index instead
    // — the same split `toggle-prompt` makes just above.
    const index = Math.max(0, Math.min(count - 1, resolved.index ?? state.focusIndex));
    const part = rowPart(view, index);
    // The keys list carries T unconditionally (keys-modal.ts), and the gutter
    // waymark only appears once a thought exists, so a writer reaches this
    // with nothing to unfold often. Say which of the two reasons applies: a
    // silent return here is indistinguishable from a dead key. `off` is its
    // own answer because the fold state this toggles renders nothing then.
    if (state.reasoning === "off") {
      state.toast = "thoughts are off · settings turns them on";
    }
    else if (part === null || !partHasThought(part, state)) {
      state.toast = "no thought on this take";
    }
    else {
      state.focusIndex = index;
      followStoryViewport(state);
      rememberFocus(state, source);
      const expanded = new Set(state.expandedThoughtIds);
      if (expanded.has(part.id)) expanded.delete(part.id);
      else expanded.add(part.id);
      state.expandedThoughtIds = expanded;
      queueThoughtLoad(state, source, context, view);
    }
  }
  else if (resolved.action === "compose") openDirectComposer(state);
  else if (resolved.action === "new-item") await createNewStory(state, source, context);
  else if (resolved.action === "continue") {
    if (generationBusy(state)) state.toast = "stream running · esc stops it first";
    else if (state.connection.down) state.toast = "offline · reading still works";
    else await context.backend.run("generating prose", (task) =>
      generate(state, source, context.cache, context.repaint, "", null, null, task));
  }
  else if (resolved.action === "quit") return requestQuit();
  else if (resolved.action === "open-map") openMap(state);
  else if (resolved.action === "open-keys") {
    state.mode = "KEYS";
    state.keysScrollTop = 0;
  }
  else if (resolved.action === "create-chapter") await createBreakAtFocus(state, source, context);
  else if (resolved.action === "chapter-previous") jumpAdjacentChapter(state, -1, source);
  else if (resolved.action === "chapter-next") jumpAdjacentChapter(state, 1, source);
  else if (resolved.action === "typewriter") state.typewriter = !state.typewriter;
  else if (resolved.action === "copy-part") await runPartAction("copy", state, source, context);
  else if (resolved.action === "copy-line") await copyPart(state, true);
  else if (resolved.action === "open-actions") {
    openActions(
      state,
      resolved.index ?? state.focusIndex,
      resolved.selectionText ?? null,
      resolved.selectionSpans ?? [],
      source
    );
  }
  else if (resolved.action === "toggle-rail") {
    state.config = { ...state.config, factsRail: state.config.factsRail === "auto" ? "off" : "auto" };
    source.config = state.config;
    if (!state.demo) saveConfig(state.config);
    state.toast = state.config.factsRail === "auto" ? "facts rail · auto at wide terminals" : "facts rail · off";
  }
  // These all share runPartAction's guard block, so keys and the menu can
  // never drift apart on what is allowed.
  else if (resolved.action === "prune") await runPartAction("prune", state, source, context);
  else if (resolved.action === "tag") await runPartAction("tag", state, source, context);
  else if (resolved.action === "edit") await runPartAction("edit", state, source, context);
  else if (resolved.action === "write") await runPartAction("write", state, source, context);
  else if (resolved.action === "regenerate") await runPartAction("retake", state, source, context);
  else if (resolved.action === "retake-with-prompt") {
    if (!resumePendingRetakeDraft(state)) {
      await runPartAction("retake-with-prompt", state, source, context);
    }
  }
  else if (resolved.action === "take-next") {
    await switchTake(state, source, 1, context);
    queueThoughtLoad(state, source, context, createStoryViewModel(state.payload, state.stream));
  }
  else if (resolved.action === "take-previous") {
    await switchTake(state, source, -1, context);
    queueThoughtLoad(state, source, context, createStoryViewModel(state.payload, state.stream));
  }
  else if (resolved.action === "take-at" && resolved.take !== undefined) {
    await switchTakeAt(state, source, resolved.take, context);
    queueThoughtLoad(state, source, context, createStoryViewModel(state.payload, state.stream));
  }
  else if (resolved.action === "undo") await undoChapterBreakChange(state, source, context);
}

/** Kick off a fetch for the now-focused part's stored thought when the row
 *  layout is about to need it — see `ensureThoughtLoaded`
 *  (reasoning-actions.ts). Called wherever focus lands somewhere new: every
 *  `rememberFocus` call site above, `toggle-thought`, and every take switch
 *  (a take swaps which node id the focused part names, per-take reasoning
 *  keyed the same way token probabilities already are). A no-op in every
 *  case that does not need it — see that function's own guards. */
function queueThoughtLoad(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  view: StoryViewModel
): void {
  const part = rowPart(view, state.focusIndex);
  if (part !== null) ensureThoughtLoaded(state, source, context, part);
}

export function closeActions(state: RuntimeState): void {
  state.actions = null;
  state.mode = "NAV";
}

export function openActions(
  state: RuntimeState,
  partIndex: number,
  selectionText: string | null = null,
  selectionSpans: readonly StorySelectionSpan[] = [],
  source?: AppSource
): void {
  const view = createStoryViewModel(state.payload, state.stream);
  const index = Math.max(0, Math.min(view.rows.length - 1, partIndex));
  const part = rowPart(view, index);
  if (part === null) return;
  state.focusIndex = index;
  state.actions = {
    cursor: 0,
    partId: part.id,
    selectionText,
    ...(selectionSpans.length === 0 ? {} : { selectionSpans })
  };
  state.mode = "ACTIONS";
  if (source !== undefined) rememberFocus(state, source);
}

/** The menu the renderer draws — one source for both, so row N on screen is
 *  always row N to a click. */
export function currentPartActions(
  state: Pick<RuntimeState, "actions" | "focusIndex" | "payload" | "stream">
    & { lineClipboard?: RuntimeState["lineClipboard"] }
): PartAction[] {
  const view = createStoryViewModel(state.payload, state.stream);
  const index = state.actions === null
    ? state.focusIndex
    : rowIndexForNode(view, state.actions.partId);
  const part = rowPart(view, index);
  const selection: PartActionSelection = state.actions?.selectionText == null
    ? "none"
    : canRewriteSelection(state.actions.selectionSpans ?? [])
      ? "rewritable"
      : "text";
  const actions = partActions(
    part?.node,
    part?.pathIndex === state.payload.path.length - 1,
    selection,
    state.lineClipboard?.storyId === state.payload.id
  );
  const persisted = part !== null && state.payload.nodes.some(({ id }) => id === part.id);
  return persisted ? actions : actions.filter(({ id }) => !partActionRequiresPersistedTarget(id));
}

/** One entry point for every part action, whether reached by mouse, menu,
 *  or NAV key — so the guards below apply uniformly. */
export async function runPartAction(
  id: PartActionId,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const view = createStoryViewModel(state.payload, state.stream);
  const partId = state.actions?.partId ?? rowPart(view, state.focusIndex)?.id ?? null;
  const selectionText = state.actions?.selectionText ?? null;
  const selectionSpans = state.actions?.selectionSpans ?? [];
  closeActions(state);
  const index = partId === null ? -1 : rowIndexForNode(view, partId);
  if (index < 0) return;
  state.focusIndex = index;
  const part = rowPart(view, state.focusIndex);
  if (part === null) return;
  const node = part.node;
  if (partActionRequiresPersistedTarget(id)
    && !state.payload.nodes.some((candidate) => candidate.id === node.id)) {
    state.toast = "generation still landing · wait before changing this part";
    return;
  }
  // Only generation needs a stream-specific guard. Local prompt phases stay
  // available; their eventual API mutations claim the backend owner.
  if (node.role === "summary" && (id === "retake" || id === "retake-with-prompt")) {
    state.toast = "summaries are rewritten, not retaken";
    return;
  }
  if (id === "continue" || id === "retake") {
    if (generationBusy(state)) {
      state.toast = "stream running · esc stops it first";
      return;
    }
    if (state.connection.down) {
      state.toast = "offline · reading still works";
      return;
    }
  }
  if (id === "rewrite-selection") {
    // Unlike continue/retake above, this only opens a local composer — the
    // same case the comment above ("Local prompt phases stay available...")
    // already carves out for retake-with-prompt. Its eventual API mutation
    // claims the backend owner at send, where composeAction re-checks both
    // guards this used to duplicate here.
    if (selectionSpans.length === 0) {
      state.toast = "highlight story text before rewriting it";
      return;
    }
  }
  if (id === "continue") await context.backend.run("generating prose", (task) =>
    generate(state, source, context.cache, context.repaint, "", null, null, task));
  else if (id === "direct") openDirectComposer(state);
  else if (id === "retake") await context.backend.run("retaking prose", (task) =>
    generate(state, source, context.cache, context.repaint, node.instruction, node, null, task));
  else if (id === "retake-with-prompt") openRetakeComposer(state, node.id, node.instruction, { kind: "retake" });
  else if (id === "write") openPartEditor(state, true);
  else if (id === "edit") openPartEditor(state, false);
  else if (id === "copy") {
    if (selectionText === null) await copyPart(state, false);
    else await copyStoryText(state, { kind: "selection", text: selectionText });
  }
  else if (id === "fact-from-selection") {
    if (selectionText === null) state.toast = "highlight story text before creating a fact";
    else openFactFromSelection(state, selectionText);
  }
  else if (id === "rewrite-selection") {
    const resolved = resolveRewriteTarget(state.payload, node.id, selectionSpans);
    if ("error" in resolved) state.toast = resolved.error;
    else openRewriteComposer(state, resolved);
  }
  else if (id === "tag") openTag(state, node.id);
  else if (id === "prune") armPrune(state, node.id);
  else if (id === "copy-line") copyStoryLineBelow(state, node.id);
  else if (id === "paste-line") await pasteStoryLineBelow(state, source, context, node.id);
}

/** Hold the source anchor, not the copied prose: `pasteStoryLineBelow`
 *  re-derives and re-validates the live chain at paste time, the same way
 *  every other multi-step story mutation here re-checks a captured id
 *  against the current payload instead of trusting stale content. */
function copyStoryLineBelow(state: RuntimeState, nodeId: string): void {
  const stats = continuationStats(state.payload, nodeId);
  if (stats.parts === 0) {
    state.toast = "nothing below this part to copy";
    return;
  }
  state.lineClipboard = {
    storyId: state.payload.id,
    sourceNodeId: nodeId,
    expectedLeafId: rememberedLeafId(state.payload, nodeId),
    parts: stats.parts
  };
  state.toast = `copied story line · ${stats.parts} ${stats.parts === 1 ? "part" : "parts"}`;
}

async function pasteStoryLineBelow(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  targetParentId: string
): Promise<void> {
  const clipboard = state.lineClipboard;
  if (clipboard === null || clipboard.storyId !== state.payload.id) {
    state.toast = "nothing copied to paste";
    return;
  }
  await context.backend.run("pasting story line", async (task) => {
    const payload = await source.api.pasteStoryLine(task.storyId, targetParentId, {
      sourceNodeId: clipboard.sourceNodeId,
      expectedLeafId: clipboard.expectedLeafId
    });
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, payload, context.cache);
    state.lineClipboard = null;
    state.toast = `pasted story line · ${clipboard.parts} ${clipboard.parts === 1 ? "part" : "parts"}`;
  });
}

function resumePendingRetakeDraft(state: RuntimeState): boolean {
  const draft = state.pendingGenerationDraft;
  if (draft?.kind !== "retake" || !draft.restored || state.retakePrompt !== null) return false;
  resumeRetakeComposer(state, draft.retakePrompt);
  // The wrapper is always `kind: "retake"` (PendingGenerationDraft has no
  // shape of its own for a rewrite session), so the noun the writer reads
  // here has to come from the session's own intent instead of the wrapper's
  // name — a rewrite's dormant draft reaching this path is not a retake.
  state.toast = draft.retakePrompt.intent.kind === "rewrite" ? "rewrite draft restored" : "retake draft restored";
  return true;
}

/** Clipboard path for exact part/line copies, independent of terminal
 * selection behavior. */
export async function copyPart(state: RuntimeState, wholeLine: boolean): Promise<void> {
  const part = rowPart(createStoryViewModel(state.payload, state.stream), state.focusIndex);
  const text = wholeLine
    ? state.payload.path.map((node) => node.text).join("\n\n")
    : part?.node.text ?? "";
  if (text.length === 0) {
    state.toast = "nothing to copy here";
    return;
  }
  const interactionVersion = state.interactionVersion;
  const outcome = await copyToClipboard(text);
  if (state.interactionVersion !== interactionVersion) return;
  const what = wholeLine ? `line · ${state.payload.path.length} parts` : `¶ ${part?.number ?? 0}`;
  state.toast = outcome === "unavailable"
    ? `no clipboard available for ${what} · inline edit or export instead`
    : `copied ${what} · ${countWords(text).toLocaleString("en-US")} words`;
}

/** Drop one attached Draft Image and release its lease. Releasing is
 *  idempotent and best-effort: the row is already gone from the composer
 *  either way, so a release failure has nothing left to undo — it only
 *  frees quota a bit sooner than the lease's own expiry would. */
function removeDraftImage(state: RuntimeState, source: AppSource, index: number): void {
  if (state.mode !== "COMPOSE") return;
  const before = draftImagesFor(state.composer);
  const removed = before[index];
  if (removed === undefined) return;
  removeDraftImageAt(state.composer, index);
  const storyId = state.payload.id;
  source.api.releaseStoryImage(storyId, removed.leaseId).catch(() => { /* best effort */ });
  state.toast = "image removed";
}

export async function actionsMenuAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const overlay = state.actions;
  if (overlay === null) return;
  const actions = currentPartActions(state);
  if (resolved.action === "cancel") closeActions(state);
  else if (resolved.action === "focus-next") overlay.cursor = Math.min(actions.length - 1, overlay.cursor + 1);
  else if (resolved.action === "focus-previous") overlay.cursor = Math.max(0, overlay.cursor - 1);
  else if (resolved.action === "focus-index") overlay.cursor = Math.max(0, Math.min(actions.length - 1, resolved.index ?? overlay.cursor));
  else if (resolved.action === "apply" || resolved.action === "open-selected") {
    const action = actions[overlay.cursor];
    if (action !== undefined) await runPartAction(action.id, state, source, context);
  }
}

export async function tagAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const prompt = state.tag;
  if (prompt === null) return;
  if (resolved.action === "cancel") {
    state.mode = prompt.returnMode;
    state.tag = null;
    return;
  }
  if (resolved.action === "apply") return await advanceOrSaveTag(state, source, context);
  if (resolved.action === "delete-tag") return await removeTag(state, source, context);
  if (prompt.choosingStatus) {
    if (resolved.action === "take-next") prompt.statusIndex = (prompt.statusIndex + 1) % TAG_STATUSES.length;
    if (resolved.action === "take-previous") prompt.statusIndex = (prompt.statusIndex - 1 + TAG_STATUSES.length) % TAG_STATUSES.length;
    return;
  }
  const name = applyTextKey(prompt.name, resolved);
  if (name !== null) prompt.name = name;
}

export async function composeAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  if (resolved.action === "cancel") {
    if (state.composer.fullscreen) state.composer.fullscreen = false;
    else {
      state.mode = "NAV";
      if (state.retakePrompt === null && state.pendingGenerationDraft?.kind === "direct") {
        resumeDirectComposer(state);
      } else claimDirectComposer(state);
    }
    return;
  }
  if (resolved.action === "toggle-compose-fullscreen") {
    state.composer.fullscreen = !state.composer.fullscreen;
    return;
  }
  if (resolved.action === "paste-clipboard") {
    await pasteClipboardIntoComposer(state, source, context);
    return;
  }
  if (resolved.action === "remove-draft-image") {
    removeDraftImage(state, source, resolved.index ?? -1);
    return;
  }
  if (resolved.action === "newline") { insertComposerText(state.composer, "\n"); return; }
  // Wrapped, an arrow follows the painted rows; unwrapped, it follows logical
  // lines. Direct alone reads the failure to move as "open history".
  const motion = composerMotion(
    state.config.wordWrap === "on",
    () => directComposerWrapWidth(
      context.renderer?.width ?? 80, state.config, state.composer.fullscreen
    )
  );
  if (resolved.action === "cursor-up" || resolved.action === "cursor-down") {
    const direction = resolved.action === "cursor-up" ? -1 : 1;
    const moved = motion.vertical(state.composer, direction, resolved.extendSelection);
    if (!moved
      && state.composer.text.length === 0
      && resolved.extendSelection !== true) {
      historyMove(state, direction);
    }
    return;
  }
  const composer = state.composer;
  const pageRows = composerPageRows(
    context.renderer?.height ?? 24,
    composer.fullscreen,
    state.config.composeMaxHeight
  );
  if (await composerSurfaceAction(resolved, state, composer, {
    isCurrent: () => state.mode === "COMPOSE" && state.composer === composer,
    pageRows,
    motion
  })) return;
  if (resolved.action === "history-previous") return historyMove(state, -1);
  if (resolved.action === "history-next") return historyMove(state, 1);
  if (resolved.action === "send" || resolved.action === "send-as-take") {
    const retakePrompt = state.retakePrompt;
    // Carries `retakePrompt` and its narrowed `intent` in one value instead
    // of two separately-nullable ones — `rewriteIntent` alone told the
    // compiler nothing about `retakePrompt`, which is exactly why the send
    // call below used to need a `!` on it.
    const rewriteSession = retakePrompt !== null && retakePrompt.intent.kind === "rewrite"
      ? { prompt: retakePrompt, intent: retakePrompt.intent }
      : null;
    // The take-destination key (issue #319) only means something inside a
    // rewrite composer; everywhere else in COMPOSE it resolves but is simply
    // unbound, same as any other unadvertised chord — not worth a toast.
    if (resolved.action === "send-as-take" && rewriteSession === null) return;
    if (generationBusy(state)) {
      state.toast = "stream running · esc stops it first · draft kept";
      return;
    }
    if (state.connection.down) {
      state.toast = "offline · draft kept until the connection returns";
      return;
    }
    const instruction = state.composer.text;
    // A rewrite composer targets a live text range, not a node to retake or
    // continue: it must re-resolve that range against the current payload
    // (the story may have moved while it sat open) and calls a differently
    // shaped API (start/end/expected, not parentId/regenerateNode). That
    // belongs beside the operation it drives — rewrite-action.ts — rather
    // than widening `generate()`'s already-branchy retake/direct path.
    if (rewriteSession !== null) {
      await submitRewriteComposer(
        state, source, context, rewriteSession.prompt, rewriteSession.intent, instruction,
        resolved.action === "send-as-take" ? "take" : undefined
      );
      return;
    }
    const retakeNode = retakePrompt === null
      ? null
      : state.payload.path.find((node) => node.id === retakePrompt.nodeId) ?? null;
    if (retakePrompt !== null && (retakeNode === null || retakeNode.role === "summary")) {
      state.composer.fullscreen = false;
      state.toast = "that part is no longer available to retake · draft kept";
      return;
    }
    await context.backend.run(retakeNode === null ? "generating prose" : "retaking prose", async (task) => {
      if (instruction.trim().length > 0) {
        state.history.push(instruction);
        if (!state.demo) {
          source.config = recordHumanWords(source.config, humanWordsOf(instruction));
          state.config = source.config;
        }
      }
      state.historyIndex = state.history.length;
      state.historyDraft = null;
      const attachedImages = draftImagesFor(state.composer);
      const pendingDraft: PendingGenerationDraft | null =
        instruction.trim().length === 0 && retakeNode === null && attachedImages.length === 0
          ? null
          : retakePrompt === null
            ? capturePendingDirectDraft(state, instruction)
            : { kind: "retake", text: instruction, retakePrompt, images: attachedImages, restored: false };
      state.pendingGenerationDraft = pendingDraft;
      state.composer.fullscreen = false;
      if (retakePrompt === null) setComposerText(state.composer, "");
      else suspendRetakeComposer(state, retakePrompt);
      state.mode = "NAV";
      await generate(
        state, source, context.cache, context.repaint,
        instruction, retakeNode, pendingDraft, task
      );
    });
    return;
  }
  if (resolved.action === "input") insertComposerText(state.composer, resolved.text ?? "");
}

export async function pruneAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  if (resolved.action === "cancel") state.prune = null;
  else if (resolved.action === "prune") await confirmPrune(state, source, context);
}

function historyMove(state: RuntimeState, direction: -1 | 1): void {
  const nextIndex = Math.max(0, Math.min(state.history.length, state.historyIndex + direction));
  if (nextIndex === state.historyIndex) return;
  if (state.historyIndex === state.history.length) state.historyDraft = state.composer.text;
  state.historyIndex = nextIndex;
  if (nextIndex === state.history.length) {
    setComposerText(state.composer, state.historyDraft ?? "");
    state.historyDraft = null;
    return;
  }
  setComposerText(state.composer, state.history[nextIndex] ?? "");
}

export function armPrune(state: RuntimeState, targetId?: string): void {
  const nodeId = targetId ?? (state.mode === "MAP"
    ? state.map?.pathCursorId
    : rowPart(createStoryViewModel(state.payload), state.focusIndex)?.id);
  if (nodeId === null || nodeId === undefined) return;
  state.prune = createPrunePlan(state.payload, nodeId);
}

export function landOnNode(state: RuntimeState, source: AppSource, targetId: string): void {
  state.focusIndex = Math.max(0, rowIndexForNode(createStoryViewModel(state.payload), targetId));
  state.mode = "NAV";
  rememberFocus(state, source);
}

export interface RerouteOrigin {
  owns(state: RuntimeState): boolean;
  release(state: RuntimeState): void;
}

export async function rerouteFromMap(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  nodeId = state.map?.pathCursorId ?? null
): Promise<void> {
  await rerouteToNode(state, source, context, nodeId, {
    owns: (current) => current.mode === "MAP" && current.map !== null,
    release: (current) => { current.map = null; }
  });
}

/** Route the line through a node and land on it.
 *
 * `origin` reports whether the surface that asked for the jump still owns the
 * screen; only then does focus move and the surface close. Every full-bleed
 * navigator (the map, search) travels through here. */
export async function rerouteToNode(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  nodeId: string | null,
  origin: RerouteOrigin
): Promise<void> {
  if (nodeId === null) return;
  // Rerouting mid-generation would let the landing take overwrite the line
  // the user just chose; the keyboard path is blocked, so this one is too.
  if (generationBusy(state)) {
    state.toast = "stream running · esc stops it first";
    return;
  }
  const target = resolveRerouteTarget(state.payload, nodeId);
  if (target === null) return;
  await context.backend.run("rerouting story", async (task) => {
    const payload = await source.api.switchLine(task.storyId, target);
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, payload, context.cache);
    const targetPathIndex = Math.max(0, payload.path.findIndex((node) => node.id === target));
    const landed = new Map(state.freshLandedAt);
    for (const node of payload.path.slice(targetPathIndex)) landed.set(node.id, Date.now());
    state.freshLandedAt = landed;
    // Painting commits a derived clone of MAP navigation back into state, so
    // object identity changes during every ordinary reroute repaint. The
    // interaction epoch is the ownership fence: close only if no later input
    // has moved the user elsewhere while the backend request was in flight.
    if (task.interactionCurrent() && origin.owns(state)) {
      origin.release(state);
      landOnNode(state, source, target);
    }
  });
}

export function openTag(state: RuntimeState, targetId?: string): void {
  const origin = state.mode === "MAP" && state.map !== null ? "MAP" : "NAV";
  const baseId = targetId ?? (origin === "MAP"
    ? state.map?.pathCursorId
    : rowPart(createStoryViewModel(state.payload), state.focusIndex)?.id ?? state.payload.path.at(-1)?.id);
  if (baseId === null || baseId === undefined) return;
  const nodeId = rememberedLeafId(state.payload, baseId, createStoryIndex(state.payload));
  const existing = state.payload.tags.find((tag) => tag.nodeId === nodeId) ?? null;
  state.tag = {
    nodeId,
    name: existing?.name ?? "",
    statusIndex: Math.max(0, TAG_STATUSES.indexOf(existing?.status ?? "")),
    choosingStatus: false,
    existing: existing !== null,
    returnMode: origin
  };
  state.mode = "TAG";
}
