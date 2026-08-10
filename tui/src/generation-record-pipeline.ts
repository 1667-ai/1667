import type {
  GenerationRecordAdjustment,
  GenerationRecordField,
  GenerationRecordKind,
  GenerationRecordPromptBlockKind,
  ResolvedGenerationRecord
} from "../../shared/generation-record.js";
import { humanEditIsMeaningful } from "../../shared/human-edit.js";
import type { PromptOperation, PromptRole } from "../../shared/prompt-plan.js";
import type { NodeStub, StoryNode } from "../../shared/types.js";

/**
 * Pure read model for the Generation Record Viewer (RECORD mode): flattens a
 * `ResolvedGenerationRecord`'s prompt entries into the one ordered list of
 * navigable rows the viewer's `entryIndex` walks, and formats the header/body
 * labels every row needs. Kept apart from `screens/generation-record-viewer.ts`
 * so the ordering and labelling rules have their own testable surface, the
 * same split `token-probabilities-model.ts` makes from its screen.
 */

/** One navigable body row. A resolved source part expands back into its
 *  original user instruction and assistant prose rows. This restores the
 *  roles and order that the compact stored source part deliberately fuses. */
export interface GenerationRecordPipelineRow {
  readonly index: number;
  readonly role: PromptRole;
  readonly label: string;
  readonly content: string;
}

const BLOCK_LABEL: Readonly<Record<GenerationRecordPromptBlockKind, string>> = {
  "author-brief": "author brief",
  facts: "facts",
  "operation-contract": "operation contract",
  source: "source",
  "authors-note": "author's note",
  request: "request",
  selection: "selection",
  boundary: "boundary",
  "completion-marker": "completion marker"
};

export function generationRecordPipelineRows(
  detail: ResolvedGenerationRecord
): readonly GenerationRecordPipelineRow[] {
  const rows: GenerationRecordPipelineRow[] = [];
  for (const entry of detail.prompt.entries) {
    if (entry.source === "text") {
      rows.push({
        index: rows.length,
        role: entry.role,
        label: `${entry.role} · ${BLOCK_LABEL[entry.kind]}`,
        content: entry.text
      });
      continue;
    }
    for (const part of entry.parts) {
      rows.push({
        index: rows.length,
        role: "user",
        label: `user · source instruction · ${part.category} · ${part.nodeId}`,
        content: part.instruction
      });
      rows.push({
        index: rows.length,
        role: "assistant",
        label: `assistant · source prose · ${part.category} · ${part.nodeId}`,
        content: part.text
      });
    }
  }
  return rows;
}

/** How many rows `generationRecordPipelineRows` would produce, without
 *  building them — what the reducer clamps `entryIndex` against. `null`
 *  (loading, failed, or missing) counts as zero, same as an empty pipeline. */
export function visibleEntryCount(detail: ResolvedGenerationRecord | null): number {
  if (detail === null) return 0;
  return generationRecordPipelineRows(detail).length;
}

/** A plain character count across every visible row's content — never a
 *  token estimate. The header labels this honestly as characters (item 6 of
 *  the accepted design), since a historical record carries no stored token
 *  count to show instead. */
export function pipelineCharacterCount(detail: ResolvedGenerationRecord): number {
  return generationRecordPipelineRows(detail).reduce((sum, row) => sum + row.content.length, 0);
}

const KIND_WORD: Readonly<Record<GenerationRecordKind, string>> = {
  continue: "continuation",
  append: "append",
  "rewrite-take": "rewrite · new take",
  "rewrite-in-place": "rewrite · in place",
  "summary-take": "summary take",
  "chapter-summary": "chapter summary",
  unsupported: "unsupported"
};

export function generationRecordKindLabel(kind: GenerationRecordKind): string {
  return KIND_WORD[kind];
}

const OPERATION_WORD: Readonly<Record<PromptOperation, string>> = {
  continue: "continue",
  rewrite: "rewrite",
  title: "title",
  summary: "summary"
};

export function generationRecordOperationLabel(operation: PromptOperation): string {
  return OPERATION_WORD[operation];
}

/** One `field: value` fragment for the effective-settings summary line. */
export function generationRecordFieldText(field: GenerationRecordField): string {
  return `${field.field}: ${field.value}`;
}

/** Construction-stage adjustments (a proactive strip a prior request already
 *  taught this model) rendered apart from retry-stage ones (this request's
 *  own mid-flight change) — the two stages say structurally different things
 *  (shared/generation-record-types.ts's `GenerationRecordAdjustment` doc). */
export function adjustmentNotices(
  adjustments: readonly GenerationRecordAdjustment[],
  stage: GenerationRecordAdjustment["stage"]
): string[] {
  return adjustments
    .filter((adjustment) => adjustment.stage === stage)
    .map((adjustment) => {
      const attempt = adjustment.attempt === undefined ? "" : ` (attempt ${adjustment.attempt})`;
      if (adjustment.action === "renamed") {
        return `${adjustment.field} renamed to ${adjustment.toField}${attempt}`;
      }
      return `${adjustment.field} ${adjustmentActionWord(adjustment.action)}${attempt}`;
    });
}

function adjustmentActionWord(action: GenerationRecordAdjustment["action"]): string {
  if (action === "skipped-cached-refusal") return "skipped · a prior request already learned this model refuses it";
  if (action === "dropped") return "dropped";
  return "added";
}

/** Non-empty only when the take's current stored text carries a human edit
 *  after generation — the record below still describes the request that
 *  produced the take's *original* text, never text a person typed
 *  afterward (shared/human-edit.ts's `HumanEditAttribution`). */
export function humanEditWarning(node: StoryNode | NodeStub | undefined): string | null {
  if (node === undefined) return null;
  const edited = "preview" in node
    ? node.editedByUser === true
    : humanEditIsMeaningful(node.attribution);
  if (!edited) return null;
  return "This take has been edited by hand since it was generated. "
    + "The request below describes the historical generation, not the current edited text.";
}
