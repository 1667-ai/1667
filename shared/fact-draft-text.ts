import { FactActivationError, parseFactScanDepth } from "./fact-metadata.js";
import { parseFactKeys, splitFactKeyLine } from "./fact-keys.js";
import { FACT_DRAFT_FIELDS, type FactDraft } from "./fact-draft.js";
import type { FactMetadataPatch, FactPatch } from "./types.js";

/**
 * The text form of a Fact draft: what a writer types into the keys, scan depth
 * and budget fields, and how it parses to a `FactDraft` and on to the wire.
 * The TUI's editor and the web UI's editor share it, so the two cannot
 * disagree about what a field accepts.
 */

export type ParsedField<T> = { ok: true; value: T } | { ok: false; toast: string };

export function formatFactKeys(keys: readonly string[]): string {
  return keys.join(", ");
}
export function formatFactScanDepth(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/** Empty text means "no budget set" — the same convention the wire uses
 *  (absent budgetTokens), so the field's own emptiness is the source of
 *  truth and no separate "cleared" flag is needed. */
export function formatFactBudget(budgetTokens: number | undefined): string {
  return budgetTokens === undefined ? "" : String(budgetTokens);
}

export function parseFactKeysText(text: string): ParsedField<string[]> {
  if (text.trim().length === 0) return { ok: true, value: [] };
  const keys = splitFactKeyLine(text);
  if (keys.some((key) => key.length === 0)) {
    return { ok: false, toast: "fact keys cannot contain an empty entry" };
  }
  try {
    return { ok: true, value: parseFactKeys(keys) };
  } catch (error) {
    if (error instanceof FactActivationError) return { ok: false, toast: error.message };
    throw error;
  }
}

export function parseSecondaryKeysText(text: string): ParsedField<string[]> {
  if (text.trim().length === 0) return { ok: true, value: [] };
  try {
    return { ok: true, value: parseFactKeys(splitFactKeyLine(text), "Fact secondary keys") };
  } catch (error) {
    return {
      ok: false,
      toast: error instanceof FactActivationError ? error.message : "invalid Fact secondary keys"
    };
  }
}

export function parseScanDepthText(text: string): ParsedField<number | undefined> {
  if (text.trim().length === 0) return { ok: true, value: undefined };
  if (!/^\d+$/u.test(text)) return { ok: false, toast: "Fact scan depth must be a whole number" };
  try {
    return { ok: true, value: parseFactScanDepth(Number(text), "Fact scan depth") };
  } catch (error) {
    return {
      ok: false,
      toast: error instanceof FactActivationError ? error.message : "invalid Fact scan depth"
    };
  }
}

/** Shared by the per-Fact budget field and the story's total Facts budget
 *  editor — same "empty means unset" convention, different bound and label. */
export function parseBudgetText(
  raw: string,
  max: number,
  label: string
): { ok: true; budgetTokens: number | undefined } | { ok: false; toast: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, budgetTokens: undefined };
  if (!budgetTextIsDigitsOrEmpty(trimmed)) {
    return { ok: false, toast: `${label} must be a whole number of tokens, or empty` };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    return { ok: false, toast: `${label} must be between 1 and ${max.toLocaleString()}` };
  }
  return { ok: true, budgetTokens: parsed };
}

/** The budget fields accept only ASCII digits while they are being edited.
 * Keep this syntax check beside the commit parser so keyboard and paste
 * admission cannot drift from the value that the save path accepts. */
export function budgetTextIsDigitsOrEmpty(raw: string): boolean {
  return raw.length === 0 || /^[0-9]+$/.test(raw);
}

/** One wire value per editable FactDraft field. The mapped table keeps the
 * ordinary Fact PATCH and the state-mutation metadata PATCH on one projection
 * of the draft; array fields are copied before they cross the editor boundary.
 */
const FACT_DRAFT_PATCH_FIELDS: {
  [K in keyof FactDraft]: (draft: FactDraft) => FactPatch[K]
} = {
  name: (draft) => draft.name ?? null,
  tag: (draft) => draft.tag,
  activation: (draft) => draft.activation,
  keys: (draft) => [...draft.keys],
  secondaryKeys: (draft) => [...draft.secondaryKeys],
  secondaryMode: (draft) => draft.secondaryMode,
  scanDepth: (draft) => draft.scanDepth ?? null,
  recursion: (draft) => draft.recursion,
  priority: (draft) => draft.priority,
  budgetTokens: (draft) => draft.budgetTokens ?? null,
  text: (draft) => draft.text
};

export interface FactDraftWireOptions {
  /** Include `name`, including `null` when the writer cleared it. */
  readonly includeName?: boolean;
}

/** Convert a validated draft to the complete ordinary Fact PATCH shape. Name
 * is omitted when unchanged because null has explicit clear semantics. */
export function factDraftToFactPatch(
  draft: FactDraft,
  options: FactDraftWireOptions = {}
): FactPatch {
  const patch = Object.fromEntries(
    FACT_DRAFT_FIELDS.map((field) => [field, FACT_DRAFT_PATCH_FIELDS[field](draft)])
  ) as FactPatch;
  if (options.includeName !== true) delete patch.name;
  return patch;
}

/** Convert the same draft to metadata for an atomic Fact State mutation. */
export function factDraftToFactMetadataPatch(
  draft: FactDraft,
  options: FactDraftWireOptions = {}
): FactMetadataPatch {
  const patch = factDraftToFactPatch(draft, options);
  delete patch.text;
  return patch;
}

