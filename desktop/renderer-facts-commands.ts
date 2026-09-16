/** Commands behind the Facts sheet's inline draft (phase 4b, 2a). Mirrors
 * the shape of `renderer-story-commands.ts`'s Fact functions — plain
 * functions over a `RendererCommandContext` — kept in a file of its own so
 * `renderer-story-commands.ts` (already near the line-length guideline)
 * does not grow further. The existing dialog-based `createFact`,
 * `editFactState`, `deleteFactState` stay in `renderer-story-commands.ts`
 * unchanged; the sheet's STATES list calls them directly. */
import type { FactInput, FactPatch, StoryFact, StoryPayload } from "../shared/types.js";
import type { RendererCommandContext } from "./renderer-command-context.js";
import { effectiveFocusedPartId } from "./renderer-model.js";
import {
  blankFactDraft,
  factBodyEditable,
  factDraftFromFact,
  factSingleStateText,
  parseFactBudget,
  type FactDraft
} from "./renderer-facts-model.js";

/** `+ New` in the Facts list: opens an empty draft in the sheet instead of
 * the form dialog `createFact` still uses when it has a node or a selection
 * (New Fact here / Fact from selection in the manuscript's `···` menu). */
export function startNewFactDraft(ctx: RendererCommandContext): void {
  ctx.setState({ tab: "facts", factEditor: { factId: null, draft: blankFactDraft() } });
}

export function selectFact(ctx: RendererCommandContext, factId: string | null): void {
  if (factId === null) {
    ctx.setState({ factEditor: null });
    return;
  }
  const fact = ctx.story().facts.find((candidate) => candidate.id === factId);
  ctx.setState({ factEditor: fact === undefined ? null : { factId, draft: factDraftFromFact(fact) } });
}

export function setFactDraft(ctx: RendererCommandContext, patch: Partial<FactDraft>): void {
  const editor = ctx.state().factEditor;
  if (editor === null) return;
  ctx.setState({ factEditor: { ...editor, draft: { ...editor.draft, ...patch } } });
}

/** Reverts the draft to the saved Fact (or, for a brand-new draft, closes
 * the sheet — there is nothing saved to revert to). */
export function revertFactEditor(ctx: RendererCommandContext): void {
  const editor = ctx.state().factEditor;
  if (editor === null) return;
  if (editor.factId === null) {
    ctx.setState({ factEditor: null });
    return;
  }
  const fact = ctx.story().facts.find((candidate) => candidate.id === editor.factId);
  ctx.setState({ factEditor: fact === undefined ? null : { factId: fact.id, draft: factDraftFromFact(fact) } });
}

export async function saveFactEditor(ctx: RendererCommandContext): Promise<void> {
  const editor = ctx.state().factEditor;
  if (editor === null) return;
  const draft = editor.draft;
  const budget = parseFactBudget(draft.budget);
  if (draft.budget.trim().length > 0 && (budget === null || !Number.isSafeInteger(budget) || budget <= 0)) {
    ctx.setState({ status: "Invalid Fact cap", error: "Fact cap must be a positive whole number." });
    return;
  }
  const api = ctx.api();
  const story = ctx.story();
  if (editor.factId === null) {
    const text = draft.body.trim();
    if (text.length === 0) {
      ctx.setState({ status: "Fact needs text", error: "Give the Fact a body before saving." });
      return;
    }
    const input: FactInput = {
      name: draft.name.trim().length === 0 ? undefined : draft.name.trim(),
      tag: draft.tag.trim().length === 0 ? undefined : draft.tag.trim(),
      text,
      activation: draft.activation,
      keys: [...draft.keys],
      priority: draft.priority === "normal" ? undefined : draft.priority,
      budgetTokens: budget ?? undefined
    };
    await ctx.run("Creating Fact", async () => {
      const next = await api.createFact(story.id, input);
      await ctx.replaceStory(next);
      selectSaved(ctx, next, next.facts.at(-1)?.id);
      ctx.setState({ status: "Fact saved" });
    });
    return;
  }
  const fact = story.facts.find((candidate) => candidate.id === editor.factId);
  if (fact === undefined) return;
  const patch: FactPatch = {
    name: draft.name.trim().length === 0 ? null : draft.name.trim(),
    tag: draft.tag.trim().length === 0 ? null : draft.tag.trim(),
    activation: draft.activation,
    keys: [...draft.keys],
    priority: draft.priority,
    budgetTokens: budget
  };
  if (factBodyEditable(fact) && draft.body !== (factSingleStateText(fact) ?? "")) patch.text = draft.body;
  await ctx.run("Saving Fact", async () => {
    const next = await api.patchFact(story.id, fact.id, patch);
    await ctx.replaceStory(next);
    selectSaved(ctx, next, fact.id);
    ctx.setState({ status: "Fact saved" });
  });
}

function selectSaved(ctx: RendererCommandContext, story: StoryPayload, factId: string | undefined): void {
  const saved = factId === undefined ? undefined : story.facts.find((candidate) => candidate.id === factId);
  ctx.setState({ factEditor: saved === undefined ? null : { factId: saved.id, draft: factDraftFromFact(saved) } });
}

type StateAddMode = "anchored" | "story-wide" | "end";

/** The sheet's three footer links (§3): each is one click, unlike the
 * manuscript's `+ Add state`, which still asks text then scope in one
 * dialog. All three call the same `createFactState` the manuscript flow
 * calls — no new StoryApi surface. */
export async function addFactStateAt(ctx: RendererCommandContext, fact: StoryFact, mode: StateAddMode): Promise<void> {
  const api = ctx.api();
  if (api.createFactState === undefined) {
    ctx.setState({ status: "Fact state editing is unavailable", error: null });
    return;
  }
  const story = ctx.story();
  const anchorPartId = mode === "story-wide" ? undefined : effectiveFocusedPartId(ctx.state(), story) ?? story.path.at(-1)?.id;
  if (mode !== "story-wide" && anchorPartId === undefined) {
    ctx.setState({ status: "No focused part to anchor to", error: null });
    return;
  }
  if (mode === "end") {
    await ctx.run("Ending Fact here", async () => {
      await ctx.replaceStory(await api.createFactState!(story.id, fact.id, { ends: true, anchorPartId }));
      ctx.setState({ status: "Fact ends here" });
    });
    return;
  }
  const text = (await ctx.textDialog("Fact state text", ""))?.trim();
  if (text === undefined || text.length === 0) return;
  await ctx.run("Adding Fact state", async () => {
    await ctx.replaceStory(await api.createFactState!(story.id, fact.id, { text, ...(anchorPartId === undefined ? {} : { anchorPartId }) }));
    ctx.setState({ status: "Fact state added" });
  });
}

/** A finding is view-only and never reaches the server; "Dismiss" only
 * removes it from this session's view. Keyed by part and index within that
 * part's findings so two parts with the same finding text stay distinct. */
export function dismissFinding(ctx: RendererCommandContext, key: string): void {
  ctx.setState({ factConsistencyDismissed: [...ctx.state().factConsistencyDismissed, key] });
}
