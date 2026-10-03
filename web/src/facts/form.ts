import { MAX_FACT_BUDGET_TOKENS } from "../../../shared/fact-budget.js";
import { EMPTY_FACT_DRAFT, type FactDraft } from "../../../shared/fact-draft.js";
import {
  formatFactBudget,
  formatFactKeys,
  formatFactScanDepth,
  parseBudgetText,
  parseFactKeysText,
  parseScanDepthText,
  parseSecondaryKeysText,
  factDraftToFactPatch
} from "../../../shared/fact-draft-text.js";
import { factTagWithinLimit, factTextWithinLimit } from "../../../shared/fact-limits.js";
import type { FactActivation, FactPriority, FactRecursion, FactSecondaryMode } from "../../../shared/fact-metadata.js";
import { MAX_FACT_TEXT_CHARS, type FactInput, type FactMetadataPatch, type FactPatch } from "../../../shared/types.js";

/**
 * A Fact editor's fields as the writer sees them: text where the writer types
 * text (keys, scan depth, budget), a choice where the writer picks one. It
 * parses to the shared `FactDraft`, and from there to the wire shapes, so the
 * web editor and the TUI editor accept the same input.
 */
export interface FactForm {
  readonly name: string;
  readonly tag: string;
  readonly text: string;
  readonly activation: FactActivation;
  readonly keys: string;
  readonly secondaryKeys: string;
  readonly secondaryMode: FactSecondaryMode;
  readonly scanDepth: string;
  readonly recursion: FactRecursion;
  readonly priority: FactPriority;
  readonly budget: string;
}

export type FactFormField = keyof FactForm;

export function formOfDraft(draft: FactDraft): FactForm {
  return {
    name: draft.name ?? "",
    tag: draft.tag ?? "",
    text: draft.text,
    activation: draft.activation,
    keys: formatFactKeys(draft.keys),
    secondaryKeys: formatFactKeys(draft.secondaryKeys),
    secondaryMode: draft.secondaryMode,
    scanDepth: formatFactScanDepth(draft.scanDepth),
    recursion: draft.recursion,
    priority: draft.priority,
    budget: formatFactBudget(draft.budgetTokens)
  };
}

export const EMPTY_FACT_FORM: FactForm = formOfDraft(EMPTY_FACT_DRAFT);

/** The fields whose value differs between two forms. */
export function changedFields(base: FactForm, form: FactForm): FactFormField[] {
  return (Object.keys(form) as FactFormField[]).filter((field) => form[field] !== base[field]);
}

export type ParsedForm = { readonly ok: true; readonly draft: FactDraft } | { readonly ok: false; readonly toast: string };

/** Validates the form the way the TUI does before a save. `needsText` is false
 * for an End State, which has no body. */
export function parseForm(form: FactForm, needsText = true): ParsedForm {
  if (needsText && form.text.trim().length === 0) return { ok: false, toast: "Write the fact text first. Draft kept." };
  if (!factTextWithinLimit(form.text)) {
    return {
      ok: false,
      toast: `The fact text is over the ${MAX_FACT_TEXT_CHARS.toLocaleString()}-character limit. Shorten it. Draft kept.`
    };
  }
  const tag = form.tag.trim();
  if (tag.length > 0 && !factTagWithinLimit(tag)) return { ok: false, toast: "That tag is too long. Draft kept." };
  const keys = parseFactKeysText(form.keys);
  if (!keys.ok) return { ok: false, toast: `${capitalize(keys.toast)}. Draft kept.` };
  const secondary = parseSecondaryKeysText(form.secondaryKeys);
  if (!secondary.ok) return { ok: false, toast: `${capitalize(secondary.toast)}. Draft kept.` };
  const scan = parseScanDepthText(form.scanDepth);
  if (!scan.ok) return { ok: false, toast: `${capitalize(scan.toast)}. Draft kept.` };
  const budget = parseBudgetText(form.budget, MAX_FACT_BUDGET_TOKENS, "fact budget");
  if (!budget.ok) return { ok: false, toast: `${capitalize(budget.toast)}. Draft kept.` };
  const name = form.name.trim();
  return {
    ok: true,
    draft: {
      name: name.length === 0 ? undefined : name,
      tag: tag.length === 0 ? null : tag,
      activation: form.activation,
      keys: keys.value,
      secondaryKeys: secondary.value,
      secondaryMode: form.secondaryMode,
      scanDepth: scan.value,
      recursion: form.recursion,
      priority: form.priority,
      budgetTokens: budget.budgetTokens,
      text: form.text
    }
  };
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1).replace(/\.$/u, "")}`;
}

/** A new Fact's wire body. `anchorPartId` anchors its first state ("Fact from
 * here"); absent means story-wide. */
export function createInputOf(draft: FactDraft, anchorPartId: string | null): FactInput {
  return {
    ...(draft.name === undefined ? {} : { name: draft.name }),
    tag: draft.tag,
    text: draft.text,
    activation: draft.activation,
    keys: [...draft.keys],
    ...(draft.secondaryKeys.length === 0 ? {} : { secondaryKeys: [...draft.secondaryKeys] }),
    ...(draft.secondaryKeys.length === 0 ? {} : { secondaryMode: draft.secondaryMode }),
    ...(draft.scanDepth === undefined ? {} : { scanDepth: draft.scanDepth }),
    recursion: draft.recursion,
    priority: draft.priority,
    ...(draft.budgetTokens === undefined ? {} : { budgetTokens: draft.budgetTokens }),
    ...(anchorPartId === null ? {} : { anchorPartId })
  };
}

const METADATA_FIELDS = new Set<FactFormField>([
  "name", "tag", "activation", "keys", "secondaryKeys", "secondaryMode", "scanDepth", "recursion", "priority", "budget"
]);

/** The ordinary PATCH body with only the fields that changed. An unchanged
 * name is left out, because `null` is what clears one. */
export function changedPatch(draft: FactDraft, changed: readonly FactFormField[]): FactPatch {
  const full = factDraftToFactPatch(draft, { includeName: changed.includes("name") });
  const keep: Record<FactFormField, keyof FactPatch> = {
    name: "name", tag: "tag", text: "text", activation: "activation", keys: "keys",
    secondaryKeys: "secondaryKeys", secondaryMode: "secondaryMode", scanDepth: "scanDepth",
    recursion: "recursion", priority: "priority", budget: "budgetTokens"
  };
  const wanted = new Set(changed.map((field) => keep[field]));
  return Object.fromEntries(Object.entries(full).filter(([key]) => wanted.has(key as keyof FactPatch))) as FactPatch;
}

/** The same, for the metadata that travels with a state change. */
export function changedMetadata(draft: FactDraft, changed: readonly FactFormField[]): FactMetadataPatch | undefined {
  const patch = changedPatch(draft, changed.filter((field) => METADATA_FIELDS.has(field)));
  return Object.keys(patch).length === 0 ? undefined : (patch as FactMetadataPatch);
}

export function metadataChanged(changed: readonly FactFormField[]): boolean {
  return changed.some((field) => METADATA_FIELDS.has(field));
}
