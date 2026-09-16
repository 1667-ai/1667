/** Pure types and helpers for the Facts sheet draft (phase 4b, 2a). Kept
 * apart from `renderer-facts-commands.ts` (which needs a
 * `RendererCommandContext`) so `renderer-model.ts` can import just the types
 * without a cycle, and apart from `renderer-facts-view.ts` so the rendering
 * file stays under the file-length guideline. */
import { FACT_ACTIVATIONS, FACT_PRIORITIES, type FactActivation, type FactPriority } from "../shared/fact-metadata.js";
import { isFactEndState, isFactStateful, resolveFactState, type FactState } from "../shared/fact-state.js";
import { estimateTokens } from "../shared/tokens.js";
import type { StoryFact, StoryPathNode } from "../shared/types.js";

export const FACTS_LIST_SCOPES = ["all", "in-force", "ended", "unscoped"] as const;
export type FactsListScope = (typeof FACTS_LIST_SCOPES)[number];

/** The Facts sheet's editable fields. `body` only means anything while the
 * selected Fact needs no state-history chrome (see `factBodyEditable`); a
 * stateful Fact shows the STATES list instead and this field is ignored on
 * save. */
export interface FactDraft {
  readonly name: string;
  readonly tag: string;
  readonly activation: FactActivation;
  readonly priority: FactPriority;
  readonly keys: readonly string[];
  /** Scalar input text for the Fact cap; `""` means no cap. */
  readonly budget: string;
  readonly body: string;
}

/** `factId: null` means the sheet is drafting a Fact that does not exist on
 * the story yet (the list's `+ New`); saving switches it to the created id. */
export interface FactEditorState {
  readonly factId: string | null;
  readonly draft: FactDraft;
}

export function blankFactDraft(): FactDraft {
  return { name: "", tag: "", activation: "always", priority: "normal", keys: [], budget: "", body: "" };
}

/** The Fact's own text when it needs no state-history chrome: exactly one
 * state, and that state holds text rather than ending the Fact. */
export function factSingleStateText(fact: StoryFact): string | null {
  if (fact.states.length !== 1) return null;
  const state = fact.states[0]!;
  return isFactEndState(state) ? null : state.text;
}

/** Whether the sheet shows a plain BODY field (true) or the STATES list
 * (false). Uses the same rule as `isFactStateful` (shared/fact-state.ts) —
 * one story-wide text state needs no state-history chrome — so a Fact
 * anchored to a part, or holding an End State, always gets the STATES list,
 * even with only one state, because the writer still needs to see and
 * change that anchor or end marker. */
export function factBodyEditable(fact: StoryFact): boolean {
  return !isFactStateful(fact);
}

export function factDraftFromFact(fact: StoryFact): FactDraft {
  return {
    name: fact.name ?? "",
    tag: fact.tag ?? "",
    activation: fact.activation,
    priority: fact.priority ?? "normal",
    keys: fact.keys,
    budget: fact.budgetTokens === undefined ? "" : String(fact.budgetTokens),
    body: factSingleStateText(fact) ?? ""
  };
}

/** `""` (nothing typed) means no cap; anything else parses as a number,
 * valid or not — the caller decides what to do with a bad value. */
export function parseFactBudget(value: string): number | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : Number(trimmed);
}

/** Names the pending changes for the D-07 bar, the same shape as
 * `describeSettingsChanges` in `renderer-settings-diff.ts`. */
export function describeFactChanges(fact: StoryFact, draft: FactDraft): readonly string[] {
  const changes: string[] = [];
  const name = draft.name.trim();
  const factName = (fact.name ?? "").trim();
  if (name !== factName) changes.push(`name ${factName || "(none)"} → ${name || "(none)"}`);
  const tag = draft.tag.trim();
  const factTag = (fact.tag ?? "").trim();
  if (tag !== factTag) changes.push(`tag ${factTag || "no tag"} → ${tag || "no tag"}`);
  if (draft.activation !== fact.activation) changes.push(`activation ${fact.activation} → ${draft.activation}`);
  const priority = fact.priority ?? "normal";
  if (draft.priority !== priority) changes.push(`priority ${priority} → ${draft.priority}`);
  if (draft.keys.length !== fact.keys.length || draft.keys.some((key, index) => key !== fact.keys[index])) {
    changes.push(`keys ${fact.keys.length} → ${draft.keys.length}`);
  }
  const budget = fact.budgetTokens === undefined ? "" : String(fact.budgetTokens);
  if (draft.budget.trim() !== budget) changes.push(`Fact cap ${budget || "no cap"} → ${draft.budget.trim() || "no cap"}`);
  if (factBodyEditable(fact) && draft.body !== (factSingleStateText(fact) ?? "")) changes.push("body edited");
  return changes;
}

/** Whether the sheet's D-07 pending bar should show: a new draft is dirty
 * once it holds anything worth saving; an existing Fact is dirty once its
 * draft differs from the saved record. */
export function factEditorDirty(fact: StoryFact | null, draft: FactDraft): boolean {
  if (fact === null) {
    return draft.name.trim().length > 0
      || draft.tag.trim().length > 0
      || draft.body.trim().length > 0
      || draft.keys.length > 0
      || draft.budget.trim().length > 0;
  }
  return describeFactChanges(fact, draft).length > 0;
}

/** STATES walk in story order: the one unscoped state (if any) first, then
 * anchored states in path order. A state anchored off the current path (a
 * branch that diverged) sorts last, oldest first — the best a single path
 * view can do without a second story line to compare against. */
export function orderedFactStates(fact: StoryFact, path: readonly Pick<StoryPathNode, "id">[]): readonly FactState[] {
  const positions = new Map(path.map((node, index) => [node.id, index] as const));
  return [...fact.states].sort((a, b) => {
    const positionOf = (state: FactState): number =>
      state.anchorPartId === undefined ? -1 : positions.get(state.anchorPartId) ?? Number.MAX_SAFE_INTEGER;
    const delta = positionOf(a) - positionOf(b);
    return delta !== 0 ? delta : a.createdAt.localeCompare(b.createdAt);
  });
}

/** The list row's mono meta line (§3): state count plus one of "state j in
 * force here", "not yet in force — anchored ¶ n", or "ended at ¶ n". */
export function factRowMeta(fact: StoryFact, path: readonly StoryPathNode[], focusedIndex: number): string {
  const stateCount = `${fact.states.length} state${fact.states.length === 1 ? "" : "s"}`;
  if (focusedIndex < 0) return stateCount;
  const resolution = resolveFactState(fact, path.slice(0, focusedIndex + 1));
  const ordered = orderedFactStates(fact, path);
  if (resolution.kind === "active") {
    const stateNumber = ordered.findIndex((state) => state.id === resolution.state.id) + 1;
    const tokens = estimateTokens(resolution.state.text);
    return `${stateCount} · state ${stateNumber} in force here · ${tokens.toLocaleString()} tok`;
  }
  if (resolution.kind === "ended") {
    const partIndex = path.findIndex((node) => node.id === resolution.state.anchorPartId);
    return partIndex === -1 ? `${stateCount} · ended` : `${stateCount} · ended at ¶ ${partIndex + 1}`;
  }
  const firstAnchored = ordered.find((state) => state.anchorPartId !== undefined);
  const anchorIndex = firstAnchored === undefined ? -1 : path.findIndex((node) => node.id === firstAnchored.anchorPartId);
  return anchorIndex === -1 ? stateCount : `${stateCount} · not yet in force — anchored ¶ ${anchorIndex + 1}`;
}

export function factMatchesScope(fact: StoryFact, path: readonly StoryPathNode[], focusedIndex: number, scope: FactsListScope): boolean {
  if (scope === "all") return true;
  if (scope === "unscoped") return fact.states.every((state) => state.anchorPartId === undefined);
  if (focusedIndex < 0) return false;
  const resolution = resolveFactState(fact, path.slice(0, focusedIndex + 1));
  return scope === "in-force" ? resolution.kind === "active" : resolution.kind === "ended";
}

export function factMatchesFilter(fact: StoryFact, query: string): boolean {
  const trimmed = query.trim().toLocaleLowerCase();
  if (trimmed.length === 0) return true;
  if ((fact.name ?? "").toLocaleLowerCase().includes(trimmed)) return true;
  if ((fact.tag ?? "").toLocaleLowerCase().includes(trimmed)) return true;
  return fact.states.some((state) => !isFactEndState(state) && state.text.toLocaleLowerCase().includes(trimmed));
}

export const FACT_ACTIVATION_LABELS: Readonly<Record<FactActivation, string>> = {
  always: "Always",
  keyed: "On keys"
};

export const FACT_PRIORITY_LABELS: Readonly<Record<FactPriority, string>> = {
  low: "Low",
  normal: "Normal",
  high: "High"
};

export { FACT_ACTIVATIONS, FACT_PRIORITIES };
