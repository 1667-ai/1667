import { TAG_STATUSES } from "../../shared/types.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import { tagGlyph } from "./tag-presentation.js";
import { generationBusy } from "./generation-action.js";
import {
  createStoryViewModel,
  lastPartRowIndex,
  popUndo,
  resolveTakeTarget,
  resolveSwitchTarget,
  rowIndexForNode,
  rowPart,
  type StoryPart
} from "./model.js";
import type { RuntimeState } from "./state.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { followStoryViewport } from "./viewport-intent.js";

export async function switchTake(
  state: RuntimeState,
  source: AppSource,
  direction: -1 | 1,
  context: ActionContext
): Promise<void> {
  return switchTakeWith(state, source, context, (part) =>
    resolveSwitchTarget(state.payload, part.id, direction));
}

export async function switchTakeAt(
  state: RuntimeState,
  source: AppSource,
  take: number,
  context: ActionContext
): Promise<void> {
  return switchTakeWith(state, source, context, (part) =>
    resolveTakeTarget(state.payload, part.id, take));
}

async function switchTakeWith(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  resolve: (part: StoryPart) =>
    { id: string; index: number; count: number } | null
): Promise<void> {
  if (generationBusy(state)) return void (state.toast = "stream running · esc stops it first");
  const part = rowPart(createStoryViewModel(state.payload), state.focusIndex);
  if (part === null) return;
  const target = resolve(part);
  if (target === null || target.id === part.id) return;
  await context.backend.run("switching take", async (task) => {
    const payload = await source.api.switchLine(task.storyId, target.id);
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, payload);
    const landed = new Map(state.freshLandedAt);
    for (const node of payload.path.slice(part.pathIndex)) landed.set(node.id, Date.now());
    state.freshLandedAt = landed;
    if (task.interactionCurrent()) {
      state.focusIndex = Math.max(0, rowIndexForNode(createStoryViewModel(payload), target.id));
      followStoryViewport(state);
      const partsBelow = payload.path.length - part.pathIndex - 1;
      // No undo hint: [←] and [→] walk the row, which is the whole of it.
      state.toast = `▸ take ${target.index}/${target.count} · ${partsBelow} parts below re-rendered`;
    }
    context.cache.invalidate();
  });
}

/** Take back the last added or removed chapter break. `u` reaches nothing else
 *  — not a chapter rename, not a summary edit, and no prose at all. */
export async function undoChapterBreakChange(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  if (generationBusy(state)) return void (state.toast = "stream running · esc stops it first");
  const popped = popUndo(state.undo);
  if (popped.entry === null) {
    return void (state.toast = "nothing to undo · u takes back an added or removed chapter break");
  }
  const entry = popped.entry;
  await context.backend.run("undoing story change", async (task) => {
    const payload = entry.kind === "create-break"
      ? (await source.api.removeChapterBreak(task.storyId, entry.breakId)).payload
      : await source.api.restoreChapterBreak(task.storyId, entry.breakId, entry.removed);
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, payload);
    state.undo = popped.rest;
    if (task.interactionCurrent()) {
      if (entry.kind === "create-break") {
        state.focusIndex = Math.min(state.focusIndex, Math.max(0, createStoryViewModel(payload).rows.length - 1));
        state.toast = "chapter break creation undone";
      } else {
        const view = createStoryViewModel(payload);
        const divider = view.rows.findIndex((row) => row.kind === "chapter-divider" && row.break.id === entry.breakId);
        state.focusIndex = divider < 0 ? lastPartRowIndex(view) : divider;
        state.toast = "chapter break restored";
      }
      followStoryViewport(state);
    }
    context.cache.invalidate();
  });
}

export async function confirmPrune(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const plan = state.prune;
  if (plan === null) return;
  if (generationBusy(state)) return void (state.toast = "stream running · esc stops it first");
  await context.backend.run("pruning story", async (task) => {
    const payload = plan.kind === "subtree"
      ? await source.api.deleteNode(task.storyId, plan.nodeId, plan.parts)
      : await source.api.pruneUnusedTakes(task.storyId, {
        expectedStoryRevision: plan.storyRevision,
        expectedTakeCount: plan.takes,
        expectedPartCount: plan.parts
      });
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, payload);
    if (state.prune === plan) state.prune = null;
    if (task.interactionCurrent()) {
      state.focusIndex = Math.min(state.focusIndex, Math.max(0, createStoryViewModel(payload).rows.length - 1));
      followStoryViewport(state);
      state.toast = plan.kind === "subtree"
        ? `pruned ${plan.parts} ${plan.parts === 1 ? "part" : "parts"}`
        : `pruned ${plan.takes} unused ${plan.takes === 1 ? "take" : "takes"} · ${plan.parts} ${plan.parts === 1 ? "part" : "parts"}`;
    }
    context.cache.invalidate();
  });
}

export async function advanceOrSaveTag(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const prompt = state.tag;
  if (prompt === null) return;
  if (!prompt.choosingStatus) {
    if (prompt.name.trim().length === 0) {
      state.toast = "tag name required";
      return;
    }
    prompt.choosingStatus = true;
    return;
  }
  const name = prompt.name.trim();
  const label = TAG_STATUSES[prompt.statusIndex]!;
  await context.backend.run("saving tag", async (task) => {
    const payload = await source.api.putBookmark(task.storyId, prompt.nodeId, name, label);
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, payload);
    if (state.tag === prompt
      && prompt.name.trim() === name
      && TAG_STATUSES[prompt.statusIndex] === label) {
      state.mode = prompt.returnMode;
      state.tag = null;
      state.toast = `${tagGlyph(label)} ${name} saved`;
    }
  });
}

export async function removeTag(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const prompt = state.tag;
  if (prompt === null || !prompt.existing) return;
  const submittedName = prompt.name;
  const submittedStatusIndex = prompt.statusIndex;
  const submittedChoosingStatus = prompt.choosingStatus;
  await context.backend.run("deleting tag", async (task) => {
    const payload = await source.api.deleteBookmark(task.storyId, prompt.nodeId);
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, payload);
    if (state.tag === prompt
      && prompt.name === submittedName
      && prompt.statusIndex === submittedStatusIndex
      && prompt.choosingStatus === submittedChoosingStatus) {
      state.mode = prompt.returnMode;
      state.tag = null;
      state.toast = "tag deleted";
    }
  });
}
