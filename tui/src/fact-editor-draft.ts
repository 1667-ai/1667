import { setComposerText } from "./composer-model.js";
import { FactActivationError, parseFactScanDepth } from "../../shared/fact-metadata.js";
import { parseFactKeys } from "../../shared/fact-keys.js";
import { splitFactKeyLine } from "../../shared/fact-keys.js";
import { MAX_FACT_BUDGET_TOKENS } from "../../shared/fact-budget.js";
import { factTextWithinLimit } from "../../shared/fact-limits.js";
import { MAX_FACT_TEXT_CHARS } from "../../shared/types.js";
import { FACT_DRAFT_FIELDS, type FactDraft } from "../../shared/fact-draft.js";
import type { FactEditorSession } from "./state.js";

/**
 * Project a Fact editor's live buffers to and from a `FactDraft` (see
 * shared/fact-draft.ts): read it (`factEditorSavePayload`, `factDraftFromEditor`),
 * write one into it (`applyFactDraftToEditor`), and tell whether it drifted
 * from the Fact it opened on (`factEditorChanged`). Kept apart from
 * fact-editor-policy.ts's row table and key handling so neither file grows
 * past the point a change to one risks the other.
 */

export function factEditorTag(editor: FactEditorSession): string | null {
  const tag = editor.tag.text.trim();
  return tag.length === 0 ? null : tag;
}

export function factEditorTagLabel(editor: FactEditorSession): string {
  return factEditorTag(editor)?.replace(/[\r\n\u2028\u2029]+/gu, "↵") ?? "none";
}

export function factEditorChanged(editor: FactEditorSession): boolean {
  return factEditorTagChanged(editor)
    || editor.activation !== editor.initialFact.activation
    || factEditorKeysChanged(editor)
    || editor.secondary.text !== formatFactKeys(editor.initialFact.secondaryKeys)
    || editor.secondaryMode !== editor.initialFact.secondaryMode
    || editor.scan.text !== formatFactScanDepth(editor.initialFact.scanDepth)
    || editor.recursion !== editor.initialFact.recursion
    || editor.priority !== editor.initialFact.priority
    || editor.budget.text !== formatFactBudget(editor.initialFact.budgetTokens)
    || editor.composer.text !== editor.initialFact.text;
}

/** Preserve the stored tag until the writer changes the tag field. */
export function factEditorPersistedTag(editor: FactEditorSession): string | null {
  return factEditorTagChanged(editor)
    ? factEditorTag(editor)
    : editor.initialFact.tag;
}

/** The editor's current draft-of-editor projection: total in the FP sense —
 *  always returns, never throws — but validation can still fail, so the
 *  result carries either the draft or the toast that explains why not. */
export function factEditorSavePayload(
  editor: FactEditorSession
): { ok: true; draft: FactDraft } | { ok: false; toast: string } {
  if (editor.composer.text.trim().length === 0) {
    return { ok: false, toast: "fact text cannot be empty" };
  }
  if (!factTextWithinLimit(editor.composer.text)) {
    return {
      ok: false,
      toast: `fact text exceeds the ${MAX_FACT_TEXT_CHARS.toLocaleString()}-character limit · shorten it before saving`
    };
  }
  const parsedKeys = factEditorKeys(editor);
  if (!parsedKeys.ok) return parsedKeys;
  const parsedBudget = factEditorBudget(editor);
  if (!parsedBudget.ok) return parsedBudget;
  const secondary = factEditorSecondaryKeys(editor);
  if (!secondary.ok) return secondary;
  const scan = factEditorScanDepth(editor);
  if (!scan.ok) return scan;
  return {
    ok: true,
    draft: {
      tag: factEditorPersistedTag(editor),
      activation: editor.activation,
      keys: factEditorKeysChanged(editor) ? parsedKeys.keys : [...editor.initialFact.keys],
      secondaryKeys: secondary.keys,
      secondaryMode: editor.secondaryMode,
      scanDepth: scan.scanDepth,
      recursion: editor.recursion,
      priority: editor.priority,
      budgetTokens: parsedBudget.budgetTokens,
      text: editor.composer.text
    }
  };
}

/** The `FactDraft` the editor's live buffers currently parse to, or `null`
 *  when they do not parse to one at all (empty body, an invalid keys or
 *  budget entry) — an editor in that state is not already showing any
 *  particular Fact, so there is nothing to compare it against. Built from
 *  `factEditorSavePayload` rather than a second hand-rolled projection, so
 *  the two cannot drift about what "the editor's current Fact" means. Used
 *  by editor-reconciliation.ts's `draftMatches` check in place of a
 *  field-by-field comparison (see `applyFactDraftToEditor` below for the
 *  inverse direction). */
export function factDraftFromEditor(editor: FactEditorSession): FactDraft | null {
  const payload = factEditorSavePayload(editor);
  return payload.ok ? payload.draft : null;
}

/** One write per `FactDraft` field, typed as a mapped type over
 *  `keyof FactDraft` — so, like `FACT_DRAFT_EQUALITY` in
 *  shared/fact-draft.ts, a field added to `FactDraft` without a matching
 *  entry here fails to compile instead of `applyFactDraftToEditor` silently
 *  leaving it unset. */
const FACT_DRAFT_WRITERS: {
  [K in keyof FactDraft]: (editor: FactEditorSession, value: FactDraft[K]) => void
} = {
  tag: (editor, value) => setComposerText(editor.tag, value ?? ""),
  activation: (editor, value) => {
    editor.activation = value;
  },
  keys: (editor, value) => setComposerText(editor.keys, formatFactKeys(value)),
  secondaryKeys: (editor, value) => setComposerText(editor.secondary, formatFactKeys(value)),
  secondaryMode: (editor, value) => {
    editor.secondaryMode = value;
  },
  scanDepth: (editor, value) => setComposerText(editor.scan, formatFactScanDepth(value)),
  recursion: (editor, value) => {
    editor.recursion = value;
  },
  priority: (editor, value) => {
    editor.priority = value;
  },
  budgetTokens: (editor, value) => setComposerText(editor.budget, formatFactBudget(value)),
  text: (editor, value) => setComposerText(editor.composer, value)
};

function writeFactDraftField<K extends keyof FactDraft>(
  field: K,
  editor: FactEditorSession,
  draft: FactDraft
): void {
  FACT_DRAFT_WRITERS[field]!(editor, draft[field]);
}

/** Apply-draft: copy a `FactDraft` into an editor's live buffers — the
 *  inverse of reading the editor. Used to rebase a pristine draft onto a
 *  fresh authoritative Fact (see editor-reconciliation.ts). Folded from
 *  `FACT_DRAFT_WRITERS` over `FACT_DRAFT_FIELDS` rather than hand-listed, so
 *  a new field cannot land here half-applied. */
export function applyFactDraftToEditor(editor: FactEditorSession, draft: FactDraft): void {
  for (const field of FACT_DRAFT_FIELDS) writeFactDraftField(field, editor, draft);
}

export function formatFactKeys(keys: readonly string[]): string {
  return keys.join(", ");
}
export function formatFactScanDepth(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/** Empty text means "no budget set" — the same convention the wire uses
 *  (absent budgetTokens), so the composer's own emptiness is the source of
 *  truth and no separate "cleared" flag is needed. */
export function formatFactBudget(budgetTokens: number | undefined): string {
  return budgetTokens === undefined ? "" : String(budgetTokens);
}

function factEditorTagChanged(editor: FactEditorSession): boolean {
  return editor.tag.text !== (editor.initialFact.tag ?? "");
}

function factEditorKeysChanged(editor: FactEditorSession): boolean {
  return editor.keys.text !== formatFactKeys(editor.initialFact.keys);
}

function factEditorKeys(
  editor: FactEditorSession
): { ok: true; keys: string[] } | { ok: false; toast: string } {
  if (editor.keys.text.trim().length === 0) return { ok: true, keys: [] };
  const keys = splitFactKeyLine(editor.keys.text);
  if (keys.some((key) => key.length === 0)) {
    return { ok: false, toast: "fact keys cannot contain an empty entry" };
  }
  try {
    return { ok: true, keys: parseFactKeys(keys) };
  } catch (error) {
    if (error instanceof FactActivationError) {
      return { ok: false, toast: error.message };
    }
    throw error;
  }
}
function factEditorSecondaryKeys(
  editor: FactEditorSession
): { ok: true; keys: string[] } | { ok: false; toast: string } {
  if (editor.secondary.text.trim().length === 0) return { ok: true, keys: [] };
  try {
    return {
      ok: true,
      keys: parseFactKeys(splitFactKeyLine(editor.secondary.text), "Fact secondary keys")
    };
  } catch (error) {
    return {
      ok: false,
      toast: error instanceof FactActivationError ? error.message : "invalid Fact secondary keys"
    };
  }
}
function factEditorScanDepth(
  editor: FactEditorSession
): { ok: true; scanDepth: number | undefined } | { ok: false; toast: string } {
  if (editor.scan.text.trim().length === 0) return { ok: true, scanDepth: undefined };
  if (!/^\d+$/u.test(editor.scan.text)) return { ok: false, toast: "Fact scan depth must be a whole number" };
  const number = Number(editor.scan.text);
  try {
    return { ok: true, scanDepth: parseFactScanDepth(number, "Fact scan depth") };
  } catch (error) {
    return {
      ok: false,
      toast: error instanceof FactActivationError ? error.message : "invalid Fact scan depth"
    };
  }
}

/** Empty clears the budget; anything else must be a whole token count within
 *  the same bound the server enforces (shared/fact-budget.ts). Validated on
 *  commit rather than live, matching how Fact keys are only parsed on save. */
function factEditorBudget(
  editor: FactEditorSession
): { ok: true; budgetTokens: number | undefined } | { ok: false; toast: string } {
  return parseBudgetText(editor.budget.text, MAX_FACT_BUDGET_TOKENS, "fact budget");
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
  if (!/^[0-9]+$/.test(trimmed)) {
    return { ok: false, toast: `${label} must be a whole number of tokens, or empty` };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    return { ok: false, toast: `${label} must be between 1 and ${max.toLocaleString()}` };
  }
  return { ok: true, budgetTokens: parsed };
}
