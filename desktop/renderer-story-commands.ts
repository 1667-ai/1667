import { isFactEndState, type FactState } from "../shared/fact-state.js";
import { continuationStats, rememberedLeafId } from "../shared/story-model.js";
import { unusedTakePruneSelection } from "../shared/story-tree.js";
import {
  TAG_STATUSES,
  type FactInput,
  type FactPatch,
  type FactStatePatch,
  type StoryFact,
  type StoryPathNode,
  type StoryPayload,
  type TagStatus
} from "../shared/types.js";
import type { RendererCommandContext } from "./renderer-command-context.js";
import { reconcileFactEditorBody } from "./renderer-facts-commands.js";
import { effectiveFocusedPartId, type TextSelection } from "./renderer-model.js";
import type { SamplingPhraseBiasEntryV2 } from "../shared/settings-v2-types.js";
import type { FactConsistencyScope } from "../shared/fact-consistency-contract.js";
import {
  FACT_ACTIVATIONS,
  FACT_PRIORITIES,
  FACT_SECONDARY_MODES
} from "../shared/fact-metadata.js";

export function copyLine(ctx: RendererCommandContext, node: StoryPathNode): void {
  const story = ctx.story();
  const stats = continuationStats(story, node.id);
  if (stats.parts === 0) {
    ctx.setState({ status: "Nothing below this part to copy", error: null });
    return;
  }
  ctx.setState({
    lineClipboard: {
      storyId: story.id,
      sourceNodeId: node.id,
      expectedLeafId: rememberedLeafId(story, node.id),
      parts: stats.parts
    },
    status: `Copied story line · ${stats.parts} part${stats.parts === 1 ? "" : "s"}`,
    error: null
  });
}

export async function pasteLine(ctx: RendererCommandContext, target: StoryPathNode): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const clipboard = ctx.state().lineClipboard;
  if (clipboard === null || clipboard.storyId !== story.id) {
    ctx.setState({ status: "Nothing copied to paste", error: null });
    return;
  }
  await ctx.run("Pasting story line", async () => {
    const payload = await api.pasteStoryLine(story.id, target.id, {
      sourceNodeId: clipboard.sourceNodeId,
      expectedLeafId: clipboard.expectedLeafId
    });
    await ctx.replaceStory(payload);
    ctx.setState({
      lineClipboard: null,
      status: `Pasted story line · ${clipboard.parts} part${clipboard.parts === 1 ? "" : "s"}`
    });
  });
}

export async function takeFromCut(ctx: RendererCommandContext, node: StoryPathNode, selection?: TextSelection): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  if (selection === undefined) {
    ctx.setState({ status: "Select text first", error: "Highlight the saved story text before creating a cut take." });
    return;
  }
  const { end: offset, expected } = selection;
  if (selection.start < 0 || offset <= selection.start || offset >= node.text.length || node.text.slice(selection.start, offset) !== expected) {
    ctx.setState({ status: "Selection changed", error: "Highlight the saved story text again." });
    return;
  }
  await ctx.run("Creating cut take", async () => {
    await ctx.replaceStory(await api.takeFromCut(story.id, node.id, { offset, expected }));
    ctx.setState({ status: "Cut take created" });
  });
}

export async function pruneUnused(ctx: RendererCommandContext): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const selection = unusedTakePruneSelection(story);
  if (selection.takeIds.length === 0) {
    ctx.setState({ status: "Nothing to prune", error: null });
    return;
  }
  if (!await ctx.confirmDialog(
    "Prune unused takes",
    `Prune ${selection.takeIds.length} unused take${selection.takeIds.length === 1 ? "" : "s"} and ${selection.nodeIds.length} part${selection.nodeIds.length === 1 ? "" : "s"}?`
  )) return;
  await ctx.run("Pruning unused takes", async () => {
    const next = await api.pruneUnusedTakes(story.id, {
      expectedStoryRevision: story.updatedAt,
      expectedTakeCount: selection.takeIds.length,
      expectedPartCount: selection.nodeIds.length
    });
    if (ctx.api() !== api || ctx.state().story?.id !== story.id) return;
    const remainingIds = new Set(next.nodes.map((part) => part.id));
    const drafts = Object.fromEntries(Object.entries(ctx.state().drafts).filter(([key]) =>
      !key.startsWith("part:") || remainingIds.has(key.slice("part:".length))
    ));
    ctx.setState({ drafts });
    await ctx.replaceStory(next);
    if (ctx.api() !== api || ctx.state().story?.id !== story.id) return;
    ctx.setState({ status: `Pruned ${selection.takeIds.length} unused take${selection.takeIds.length === 1 ? "" : "s"}` });
  });
}

export async function tagLine(ctx: RendererCommandContext, node: StoryPathNode): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const nodeId = rememberedLeafId(story, node.id);
  const existing = story.tags.find((tag) => tag.nodeId === nodeId);
  const name = (await ctx.textDialog("Line tag name", existing?.name ?? ""))?.trim();
  if (name === undefined || name.length === 0) return;
  const chosenStatus = await ctx.choiceDialog("Line tag status", TAG_STATUSES, existing?.status || "Draft");
  if (chosenStatus === null) return;
  const requestedStatus = chosenStatus.trim();
  if (!(TAG_STATUSES as readonly string[]).includes(requestedStatus)) {
    ctx.setState({ status: "Invalid tag status", error: "Use Canon, Alt, Draft, Discarded, Summary, or an empty status." });
    return;
  }
  await ctx.run("Saving line tag", async () => {
    await ctx.replaceStory(await api.putBookmark(story.id, nodeId, name, requestedStatus as TagStatus));
    ctx.setState({ status: `Tagged line “${name}”` });
  });
}

export async function removeTag(ctx: RendererCommandContext, node: StoryPathNode): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const nodeId = rememberedLeafId(story, node.id);
  const existing = story.tags.find((tag) => tag.nodeId === nodeId);
  if (existing === undefined || !await ctx.confirmDialog("Remove line tag", `Remove tag “${existing.name}”?`)) return;
  await ctx.run("Removing line tag", async () => {
    await ctx.replaceStory(await api.deleteBookmark(story.id, nodeId));
    ctx.setState({ status: "Line tag removed" });
  });
}

export async function exportMarkdown(ctx: RendererCommandContext): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  await ctx.run("Exporting Markdown", async () => {
    const result = await api.exportMarkdown(story.id);
    const blob = new Blob([result.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName(story.title)}.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    ctx.setState({
      status: result.fidelity.length === 0
        ? "Markdown exported"
        : `Markdown exported · ${result.fidelity.length} omission${result.fidelity.length === 1 ? "" : "s"}`
    });
  });
}

export function importMarkdown(ctx: RendererCommandContext): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md,.markdown,.txt,.jsonl,.story,.scenario,text/markdown,text/plain,application/json";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file === undefined) return;
    void file.text().then((text) => importStoryText(ctx, text, file.name));
  }, { once: true });
  input.click();
}

async function importStoryText(ctx: RendererCommandContext, text: string, fileName: string): Promise<void> {
  const api = ctx.api();
  const lowerName = fileName.toLocaleLowerCase();
  if (!await ctx.confirmDiscardDrafts()) return;
  await ctx.discardDrafts();
  await ctx.run(`Importing ${lowerName.endsWith(".story") ? "NovelAI story" : lowerName.endsWith(".scenario") ? "scenario" : lowerName.endsWith(".jsonl") ? "SillyTavern story" : "Markdown"}`, async () => {
    const result = lowerName.endsWith(".story")
      ? await api.importNovelAI(text)
      : lowerName.endsWith(".scenario")
        ? await api.importScenario(text)
        : lowerName.endsWith(".jsonl")
          ? await api.importSillyTavern(text)
          : { payload: await api.importMarkdown(text, fileName.replace(/\.(?:markdown|md|txt)$/iu, "").trim() || undefined), fidelity: [] as readonly string[] };
    await ctx.replaceStory(result.payload);
    await ctx.refresh();
    ctx.setState({ status: `${result.payload.title} imported${result.fidelity.length === 0 ? "" : ` · ${result.fidelity.length} omissions`}` });
  });
}

export function importCard(ctx: RendererCommandContext): void {
  importBytes(ctx, ".png,.json,application/json,image/png", "character card", async (api, storyId, bytes) => {
    const result = await api.importCard(storyId, bytes);
    return { payload: result.payload, status: `Character card imported · ${result.plan.facts.length} Facts${result.plan.fidelity.length === 0 ? "" : ` · ${result.plan.fidelity.length} omissions`}` };
  });
}

export function importLorebook(ctx: RendererCommandContext): void {
  importBytes(ctx, ".zip,.lorebook,application/zip", "lorebook", async (api, storyId, bytes) => {
    const result = await api.importLorebook(storyId, bytes);
    return { payload: result.payload, status: `Lorebook imported · ${result.importResult.facts.length} Facts${result.importResult.fidelity.length === 0 ? "" : ` · ${result.importResult.fidelity.length} omissions`}` };
  });
}

function importBytes(
  ctx: RendererCommandContext,
  accept: string,
  label: string,
  apply: (api: ReturnType<RendererCommandContext["api"]>, storyId: string, bytes: Uint8Array) => Promise<{ payload: StoryPayload; status: string }>
): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file === undefined) return;
    void file.arrayBuffer().then(async (value) => {
      const story = ctx.story();
      if (!await ctx.confirmDiscardDrafts()) return;
      await ctx.discardDrafts();
      await ctx.run(`Importing ${label}`, async () => {
        const result = await apply(ctx.api(), story.id, new Uint8Array(value));
        await ctx.replaceStory(result.payload);
        ctx.setState({ status: result.status });
      });
    });
  }, { once: true });
  input.click();
}

/** Optional story source for the part tools. A selected span seeds the text;
 * the part remains the Fact anchor so the new Fact follows that line. */
export async function createFact(
  ctx: RendererCommandContext,
  node?: Pick<StoryPathNode, "id" | "text">,
  selection?: TextSelection
): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  if (selection !== undefined) {
    if (node === undefined
      || selection.start < 0
      || selection.end <= selection.start
      || selection.end > node.text.length
      || node.text.slice(selection.start, selection.end) !== selection.expected) {
      ctx.setState({ status: "Selection changed", error: "Highlight the saved story text again." });
      return;
    }
  }
  const name = (await ctx.textDialog("Fact name", ""))?.trim();
  if (name === undefined) return;
  const selectedText = selection?.expected ?? "";
  const text = (await ctx.textDialog(
    "Fact text",
    selectedText,
    selection === undefined ? undefined : "Edit the highlighted text before saving the Fact.",
    true
  ))?.trim();
  if (text === undefined || text.length === 0) return;
  const input: FactInput = {
    name,
    text,
    activation: "always",
    keys: [],
    ...(node === undefined ? {} : { anchorPartId: node.id })
  };
  await ctx.run("Creating Fact", async () => { await ctx.replaceStory(await api.createFact(story.id, input)); });
}

export async function deleteFact(ctx: RendererCommandContext, factId: string): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const fact = story.facts.find((item) => item.id === factId);
  if (fact === undefined || !await ctx.confirmDialog("Delete Fact", `Delete Fact “${fact.name ?? "Untitled Fact"}”?`)) return;
  await ctx.run("Deleting Fact", async () => { await ctx.replaceStory(await api.deleteFact(story.id, factId)); });
}

export async function editFact(ctx: RendererCommandContext, fact: StoryFact): Promise<void> {
  const values = await ctx.formDialog("Edit Fact", [
    { id: "name", label: "Name", kind: "text", value: fact.name ?? "" },
    { id: "tag", label: "Tag", kind: "text", value: fact.tag ?? "" },
    { id: "activation", label: "Activation", kind: "choice", value: fact.activation, options: FACT_ACTIVATIONS },
    { id: "keys", label: "Keys", kind: "textarea", value: fact.keys.join(", "), message: "Separate keys with commas or new lines." },
    { id: "secondaryKeys", label: "Secondary keys", kind: "textarea", value: fact.secondaryKeys?.join(", ") ?? "", message: "Optional gate keys." },
    { id: "secondaryMode", label: "Secondary key rule", kind: "choice", value: fact.secondaryMode ?? "and", options: FACT_SECONDARY_MODES },
    { id: "priority", label: "Priority", kind: "choice", value: fact.priority ?? "normal", options: FACT_PRIORITIES },
    { id: "budget", label: "Token budget", kind: "number", value: fact.budgetTokens === undefined ? "" : String(fact.budgetTokens), message: "Leave empty for no per-Fact cap." }
  ], "Update the Fact metadata, then save once.");
  if (values === null) return;
  const name = values.name ?? "";
  const tag = values.tag ?? "";
  const activation = values.activation ?? fact.activation;
  const keys = values.keys ?? "";
  const secondaryKeys = values.secondaryKeys ?? "";
  const secondaryMode = values.secondaryMode ?? fact.secondaryMode ?? "and";
  const priority = values.priority ?? fact.priority ?? "normal";
  const budget = values.budget ?? "";
  const budgetValue = budget.trim().length === 0 ? null : Number(budget.trim());
  if (budgetValue !== null && (!Number.isSafeInteger(budgetValue) || budgetValue <= 0)) {
    ctx.setState({ status: "Invalid Fact budget", error: "Fact budget must be a positive whole number." });
    return;
  }
  const patch: FactPatch = {
    name: name.trim().length === 0 ? null : name.trim(),
    tag: tag.trim().length === 0 ? null : tag.trim(),
    activation: parseChoice(activation, FACT_ACTIVATIONS, fact.activation),
    keys: parseKeys(keys),
    secondaryKeys: parseKeys(secondaryKeys).length === 0 ? null : parseKeys(secondaryKeys),
    secondaryMode: parseChoice(secondaryMode, FACT_SECONDARY_MODES, fact.secondaryMode ?? "and"),
    priority: parseChoice(priority, FACT_PRIORITIES, fact.priority ?? "normal"),
    budgetTokens: budgetValue
  };
  await ctx.run("Saving Fact", async () => {
    await ctx.replaceStory(await ctx.api().patchFact(ctx.story().id, fact.id, patch));
    ctx.setState({ status: "Fact saved" });
  });
}

export async function moveFact(ctx: RendererCommandContext, factId: string, direction: -1 | 1): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const index = story.facts.findIndex((fact) => fact.id === factId);
  if (index < 0) return;
  await ctx.run("Reordering Facts", async () => { await ctx.replaceStory(await api.reorderFact(story.id, factId, index + direction)); });
}

export async function editFactState(ctx: RendererCommandContext, fact: StoryFact, state: FactState): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  if (api.patchFactState === undefined) return;
  const activePart = story.path.at(-1);
  const currentEnds = isFactEndState(state);
  const currentScope = state.anchorPartId === undefined
    ? "Story-wide"
    : activePart?.id === state.anchorPartId
      ? "After active part"
      : "Keep current anchor";
  const scopeOptions = ["Keep current anchor", "Story-wide", ...(activePart === undefined ? [] : ["After active part"])] as const;
  const values = await ctx.formDialog("Edit Fact state", [
    {
      id: "text",
      label: "Text",
      kind: "textarea",
      value: currentEnds ? "" : state.text,
      message: "Use the text field when this state does not end the Fact."
    },
    {
      id: "scope",
      label: "Scope",
      kind: "choice",
      value: currentScope,
      options: scopeOptions
    },
    {
      id: "ends",
      label: "Ends here",
      kind: "choice",
      value: currentEnds ? "Yes" : "No",
      options: ["No", "Yes"]
    }
  ], "Change the state text, anchor, or end marker, then save once.");
  if (values === null) return;
  const text = values.text?.trim() ?? "";
  const ends = values.ends === "Yes" || text.toUpperCase() === "END";
  if (!ends && text.length === 0) {
    ctx.setState({ status: "Fact state needs text", error: "Enter text or set Ends here to Yes." });
    return;
  }
  const scope = values.scope ?? currentScope;
  if (!scopeOptions.includes(scope as typeof scopeOptions[number])) {
    ctx.setState({ status: "Invalid Fact state scope", error: "Choose a valid Fact state scope." });
    return;
  }
  const anchorPatch: Pick<FactStatePatch, "anchorPartId"> =
    scope === "Story-wide"
      ? { anchorPartId: null }
      : scope === "After active part"
        ? activePart === undefined
          ? {}
          : { anchorPartId: activePart.id }
        : {};
  const patch: FactStatePatch = ends
    ? { ends: true, ...anchorPatch }
    : { text, ...anchorPatch };
  const anchorChanged = "anchorPartId" in anchorPatch
    && (anchorPatch.anchorPartId ?? undefined) !== state.anchorPartId;
  const valueChanged = currentEnds !== ends || (!ends && !currentEnds && state.text !== text);
  if (!anchorChanged && !valueChanged) return;
  await ctx.run("Editing Fact state", async () => {
    await ctx.replaceStory(await api.patchFactState!(story.id, fact.id, state.id, patch));
    reconcileFactEditorBody(ctx, fact.id);
    ctx.setState({ status: "Fact state updated" });
  });
}

export async function deleteFactState(ctx: RendererCommandContext, fact: StoryFact, state: FactState): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  if (api.deleteFactState === undefined || fact.states.length <= 1) return;
  if (!await ctx.confirmDialog("Delete Fact state", "Delete this Fact state?")) return;
  await ctx.run("Deleting Fact state", async () => {
    await ctx.replaceStory(await api.deleteFactState!(story.id, fact.id, state.id));
    reconcileFactEditorBody(ctx, fact.id);
    ctx.setState({ status: "Fact state deleted" });
  });
}

export async function createChapter(ctx: RendererCommandContext, parentPartId?: string): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const parent = parentPartId === undefined
    ? story.path.at(-1)
    : story.path.find((node) => node.id === parentPartId);
  if (parent === undefined) return;
  const title = (await ctx.textDialog("Chapter title", "Untitled chapter"))?.trim();
  if (title === undefined) return;
  await ctx.run("Creating chapter", async () => {
    const result = await api.createChapterBreak(story.id, parent.id, title);
    await ctx.replaceStory(result.payload);
    ctx.setState({ chapterUndo: { kind: "added", breakId: result.breakId } });
  });
}

export async function renameChapter(ctx: RendererCommandContext, id: string, current: string): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const title = (await ctx.textDialog("Chapter title", current))?.trim();
  if (title === undefined || title.length === 0 || title === current) return;
  await ctx.run("Renaming chapter", async () => { await ctx.replaceStory(await api.renameChapterBreak(story.id, id || null, title)); });
}

export async function removeChapter(ctx: RendererCommandContext, id: string, title: string): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  if (!await ctx.confirmDialog("Remove chapter", `Remove chapter “${title}”?`)) return;
  await ctx.run("Removing chapter", async () => {
    const result = await api.removeChapterBreak(story.id, id);
    await ctx.replaceStory(result.payload);
    ctx.setState({ chapterUndo: { kind: "removed", breakId: id, removed: result.removed }, status: "Chapter removed · restore is available" });
  });
}

/** `u` (and the Chapters header's "Restore removed" button): reverses
 * whichever chapter-break operation happened last. Restoring a removal
 * clears the undo record (matching the TUI, one step of history). Removing
 * an addition instead records a fresh `removed` entry from that removal's
 * own response, so pressing `u` again restores it — the same toggle the TUI
 * gives `C` then `u` then `u`. */
export async function restoreChapter(ctx: RendererCommandContext): Promise<void> {
  const story = ctx.story();
  const undo = ctx.state().chapterUndo;
  if (undo === null) {
    ctx.setState({ status: "Nothing to undo", error: null });
    return;
  }
  if (undo.kind === "removed") {
    await ctx.run("Restoring chapter", async () => {
      await ctx.replaceStory(await ctx.api().restoreChapterBreak(story.id, undo.breakId, undo.removed));
      ctx.setState({ chapterUndo: null, status: "Chapter break restored" });
    });
    return;
  }
  await ctx.run("Removing chapter break", async () => {
    const result = await ctx.api().removeChapterBreak(story.id, undo.breakId);
    await ctx.replaceStory(result.payload);
    ctx.setState({ chapterUndo: { kind: "removed", breakId: undo.breakId, removed: result.removed }, status: "Chapter break removed · u restores it" });
  });
}

export async function editChapterSummary(
  ctx: RendererCommandContext,
  chapter: { readonly id: string; readonly title: string },
  node: Pick<StoryPathNode, "id" | "text">
): Promise<void> {
  const value = await ctx.textDialog("Chapter summary", node.text, "Edit the saved summary for this chapter.", true);
  if (value === null || value === node.text) return;
  await ctx.run("Saving chapter summary", async () => {
    await ctx.replaceStory(await ctx.api().editChapterSummary(ctx.story().id, node.id, value, node.text));
    ctx.setState({ status: `Summary saved for ${chapter.title}` });
  });
}

export async function summarizeChapter(ctx: RendererCommandContext, id: string, title: string): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  await ctx.run(`Summarizing ${title}`, async () => {
    const payload = await api.summarizeChapter(story.id, id);
    if (ctx.state().story?.id === story.id && ctx.api() === api) await ctx.replaceStory(payload);
  });
}

export async function editPhraseBias(ctx: RendererCommandContext): Promise<void> {
  const story = ctx.story();
  const current = (story.phraseBias ?? []).map((entry) => `${entry.phrase}: ${entry.weight}`).join("\n");
  const value = await ctx.textDialog(
    "Story phrase bias",
    current,
    "One phrase and weight per line. Weight must be between -100 and 100.",
    true
  );
  if (value === null) return;
  const entries = parsePhraseBias(value);
  if (entries === null) {
    ctx.setState({ status: "Invalid phrase bias", error: "Use one phrase: weight entry per line." });
    return;
  }
  await ctx.run("Saving phrase bias", async () => {
    await ctx.replaceStory(await ctx.api().setPhraseBias(story.id, entries));
    ctx.setState({ status: entries.length === 0 ? "Phrase bias cleared" : "Phrase bias saved" });
  });
}

export async function editBannedStrings(ctx: RendererCommandContext): Promise<void> {
  const story = ctx.story();
  const current = (story.bannedStrings ?? []).join("\n");
  const value = await ctx.textDialog(
    "Story banned strings",
    current,
    "One string per line. The model will make each string less likely.",
    true
  );
  if (value === null) return;
  const values = [...new Set(value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean))];
  await ctx.run("Saving banned strings", async () => {
    await ctx.replaceStory(await ctx.api().setBannedStrings(story.id, values));
    ctx.setState({ status: values.length === 0 ? "Banned strings cleared" : "Banned strings saved" });
  });
}

export async function runFactConsistency(ctx: RendererCommandContext, scope: FactConsistencyScope): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const isCurrent = (): boolean => {
    try { return ctx.state().story?.id === story.id && ctx.api() === api; }
    catch { return false; }
  };
  const focusedPartId = effectiveFocusedPartId(ctx.state(), story) ?? story.path.at(-1)?.id;
  if (focusedPartId === undefined || api.planFactConsistency === undefined || api.checkFactConsistency === undefined) {
    ctx.setState({ status: "Fact consistency is unavailable", error: null });
    return;
  }
  ctx.setState({ factConsistencyBusy: true, error: null, status: "Planning Fact consistency" });
  try {
    const input = { storyId: story.id, focusedPartId, scope };
    const plan = await api.planFactConsistency(input);
    if (!isCurrent()) return;
    const confirmed = await ctx.confirmDialog("Check Facts", `Check ${plan.partCount} part${plan.partCount === 1 ? "" : "s"} with ${plan.requestCount} provider request${plan.requestCount === 1 ? "" : "s"}?`);
    if (!isCurrent()) return;
    if (!confirmed) {
      ctx.setState({ factConsistencyBusy: false, status: "Fact check cancelled" });
      return;
    }
    const result = await api.checkFactConsistency({ ...input, planToken: plan.planToken });
    if (!isCurrent()) return;
    await ctx.replaceStory(result.payload);
    ctx.setState({ factConsistency: result.run, factConsistencyBusy: false, factConsistencySeen: false, factConsistencyDismissed: [], status: "Fact check complete" });
  } catch (error) {
    if (!isCurrent()) return;
    ctx.setState({ factConsistencyBusy: false, status: "Fact check failed", error: error instanceof Error ? error.message : String(error) });
  }
}

export async function showFactConsistency(ctx: RendererCommandContext): Promise<void> {
  const story = ctx.story();
  const api = ctx.api();
  if (api.getFactConsistencyRun === undefined) {
    ctx.setState({ status: "Fact findings are unavailable", error: null });
    return;
  }
  await ctx.run("Loading Fact findings", async () => {
    const run = await api.getFactConsistencyRun!(story.id);
    if (ctx.state().story?.id === story.id && ctx.api() === api) ctx.setState({ factConsistency: run, factConsistencyDismissed: [] });
  });
}

function safeFileName(title: string): string {
  const value = title.trim().replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "");
  return value.length === 0 ? "untitled-story" : value.slice(0, 96);
}

function parsePhraseBias(value: string): readonly SamplingPhraseBiasEntryV2[] | null {
  const entries: SamplingPhraseBiasEntryV2[] = [];
  for (const line of value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean)) {
    const separator = line.lastIndexOf(":");
    if (separator <= 0) return null;
    const phrase = line.slice(0, separator).trim();
    const weight = Number(line.slice(separator + 1).trim());
    if (phrase.length === 0 || !Number.isFinite(weight) || weight < -100 || weight > 100) return null;
    entries.push({ phrase, weight });
  }
  return entries;
}

function parseKeys(value: string): string[] {
  return [...new Set(value.split(/[\r\n,]/u).map((entry) => entry.trim()).filter(Boolean))];
}

function parseChoice<T extends string>(value: string, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? value as T : fallback;
}
