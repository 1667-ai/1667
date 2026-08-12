import {
  type GenerationRecordPromptEntry,
  type GenerationRecordSourcePart,
  type GenerationRecordTextEntry
} from "../shared/generation-record.js";
import {
  foldAuthorsNoteAcross,
  type PromptBlock,
  type PromptPlan,
  type PromptRole,
  type PromptTurn
} from "../shared/prompt-plan.js";
import type { ContinuationPromptEntry } from "../shared/continuation-plan.js";
import type { Story, StoryNode } from "../shared/types.js";
import { reusableStoredRevisionId } from "./story-node-text.js";

/**
 * Turns a built prompt into the bounded, secret-free, order-preserving
 * entries a Generation Record stores. Two shapes, matching how a prompt is
 * actually assembled:
 *
 * `continuationRecordEntries` is for continuation and append, seeded from a
 * `ContinuationPlan.entries` array rather than the rendered `PromptPlan` —
 * the plan alone has already flattened each context part down to two
 * anonymous chat turns, indistinguishable from every other turn of the same
 * role. The caller passes that array through `foldContinuationAuthorsNote`
 * first exactly when the same generation's provider request would also fold
 * it (`provider-request-body.ts`'s `providerFoldsAuthorsNote`), so the
 * stored record always matches the wire prompt it documents. The
 * richer plan still carries each part's category, node id, and its exact
 * position relative to the Author's Note, which is what the Generation
 * Record Viewer needs to show the same ordered, categorized pipeline the
 * Next Request preview does. Every non-part entry becomes one text entry per
 * text block it carries, in order — the final turn carries two (the
 * operation contract, then the request or the boundary echo; issue #138 /
 * PR #148 folds the contract into that turn instead of giving it one of its
 * own), and a record that showed only the first would both mislabel the
 * entry as `operation-contract` and silently drop the request's own text, so
 * every text block gets its own entry, the same one-entry-per-block rule
 * `promptEntriesInline` below already uses. Every run of context parts
 * becomes one `source` entry whose `parts` array preserves per-part identity
 * (node id, category, and the part's own short instruction, kept inline
 * since it is not content-addressed the way the part's prose is) without
 * inlining the prose itself — that is the one potentially unbounded input a
 * request carries, so it rides as a revision reference instead, resolved on
 * demand by `server/generation-record-resolve.ts`. Splitting only at the
 * Author's Note keeps the entry count fixed no matter how deep the story
 * runs; the depth lives in `parts`, not in the top-level entry array.
 *
 * `promptEntriesInline` is for every other operation (a rewrite, a summary,
 * a chapter summary), whose prompt is a flat `PromptPlan` with no richer
 * plan behind it and whose own "source" text (a rewrite's passage, a
 * summary's fixed excerpt) is bounded to what that one request touched, not
 * the whole story — inlining it is both simple and honest. One entry per
 * original block, in order; never bucketed by kind, so two blocks that
 * happen to share a kind never collapse into one.
 */

export function continuationRecordEntries(
  story: Story,
  entries: readonly ContinuationPromptEntry[]
): GenerationRecordPromptEntry[] {
  const byId = new Map(story.nodes.map((node) => [node.id, node] as const));
  const built: GenerationRecordPromptEntry[] = [];
  let run: GenerationRecordSourcePart[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    built.push({ stability: "stable", kind: "source", source: "revisions", parts: run });
    run = [];
  };
  for (let index = 0; index < entries.length; index++) {
    const planEntry = entries[index]!;
    if (planEntry.partId === undefined) {
      flushRun();
      const textBlocks = planEntry.turn.blocks.filter(isTextBlock);
      if (textBlocks.length === 0) {
        throw new Error("Prompt turn has no text block to cite in a Generation Record");
      }
      for (const block of textBlocks) built.push(textEntry(planEntry.turn.role, block));
      continue;
    }
    // Every context part is a user instruction turn immediately followed by
    // its assistant prose turn (shared/continuation-plan.ts's own
    // `partEntries.flatMap` pairing) — never split by anything else,
    // including the Author's Note, which only ever lands between complete
    // pairs. A plan that violates this is a bug in the plan builder, not
    // untrusted input, so this fails loudly rather than silently mispairing
    // an instruction with the wrong part's prose.
    const prose = entries[index + 1];
    if (prose === undefined || prose.partId !== planEntry.partId) {
      throw new Error(`Malformed continuation plan: part ${planEntry.partId} has no matching prose turn`);
    }
    index += 1;
    const part = sourcePart(byId, planEntry);
    if (part !== null) run.push(part);
  }
  flushRun();
  return built;
}

/** Mirror `provider-request-body.ts`'s wire lowering without flattening away
 * source identity: the same canonical `foldAuthorsNoteAcross` fold, applied
 * to the richer continuation entries instead of the flat `PromptPlan` turns.
 * When the folded block introduces a story part, the folded text remains
 * that source part's instruction; its prose still stays behind the
 * immutable revision reference. */
export function foldContinuationAuthorsNote(
  entries: readonly ContinuationPromptEntry[]
): readonly ContinuationPromptEntry[] {
  return foldAuthorsNoteAcross(entries, (entry) => entry.turn, (entry, turn) => ({ ...entry, turn }));
}

function sourcePart(
  byId: ReadonlyMap<string, StoryNode>,
  instructionEntry: Extract<ContinuationPromptEntry, { partId: string }>
): GenerationRecordSourcePart | null {
  const node = byId.get(instructionEntry.partId);
  // A node the plan cited but the story no longer has, or one whose prose
  // raced to empty between plan-build and record-build, carries nothing to
  // reference — that is a narrow, honest gap, not a fabricated reference.
  if (node === undefined || node.text.trim().length === 0) return null;
  const revisionId = reusableStoredRevisionId(node);
  // A node with real prose but no durable, reusable revision — an
  // unmigrated legacy story's context, most commonly — cannot be cited
  // safely: silently dropping it would let the record claim a complete
  // pipeline while omitting historical prose the provider actually saw.
  // The caller (`finalizeGenerationRecord` / `captureGenerationRecordHandoff`)
  // already turns a thrown entries() failure into an explicit `unsupported`
  // record instead of a partial one.
  if (revisionId === undefined) {
    throw new Error(`Story node ${node.id} has prose but no reusable stored revision to reference`);
  }
  return {
    nodeId: node.id,
    category: instructionEntry.category,
    instruction: firstTextBlock(instructionEntry.turn).text,
    revisionId,
    textLength: node.text.length
  };
}

export function promptEntriesInline(plan: PromptPlan): GenerationRecordPromptEntry[] {
  return plan.turns.flatMap((turn) =>
    turn.blocks.filter(isTextBlock).map((block) => textEntry(turn.role, block))
  );
}

/** Every `PromptBlock` this module can represent as prose. An image block
 *  carries no `text` and never enters a Generation Record entry — the same
 *  "never store the bytes, never a description" rule that keeps base64 out
 *  of every other record (see shared/image-attachment.ts). A turn that
 *  carries images always carries them before its text block
 *  (shared/prompt-plan.ts's `ImagePromptBlock`), so skipping leading image
 *  blocks and citing the first text block still cites the exact instruction
 *  the provider read. */
type TextPromptBlock = Exclude<PromptBlock, { kind: "image" }>;

function isTextBlock(block: PromptBlock): block is TextPromptBlock {
  return block.kind !== "image";
}

function firstTextBlock(turn: PromptTurn): TextPromptBlock {
  const block = turn.blocks.find(isTextBlock);
  if (block === undefined) {
    throw new Error("Prompt turn has no text block to cite in a Generation Record");
  }
  return block;
}

function textEntry(role: PromptRole, block: TextPromptBlock): GenerationRecordTextEntry {
  return {
    role,
    stability: block.stability,
    kind: block.kind,
    source: "text",
    text: block.text
  };
}
