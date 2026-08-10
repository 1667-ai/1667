import {
  type GenerationRecordPromptEntry,
  type GenerationRecordSourcePart,
  type GenerationRecordTextEntry
} from "../shared/generation-record.js";
import type { PromptBlock, PromptPlan, PromptRole } from "../shared/prompt-plan.js";
import type { ContinuationPlan, ContinuationPromptEntry } from "../shared/continuation-plan.js";
import type { Story, StoryNode } from "../shared/types.js";
import { reusableStoredRevisionId } from "./story-node-text.js";

/**
 * Turns a built prompt into the bounded, secret-free, order-preserving
 * entries a Generation Record stores. Two shapes, matching how a prompt is
 * actually assembled:
 *
 * `continuationRecordEntries` is for continuation and append, seeded from
 * `ContinuationPlan.entries` rather than the rendered `PromptPlan` — the plan
 * alone has already flattened each context part down to two anonymous chat
 * turns, indistinguishable from every other turn of the same role. The
 * richer plan still carries each part's category, node id, and its exact
 * position relative to the Author's Note, which is what the Generation
 * Record Viewer needs to show the same ordered, categorized pipeline the
 * Next Request preview does. Every non-part entry becomes its own text
 * entry, in order; every run of context parts becomes one `source` entry
 * whose `parts` array preserves per-part identity (node id, category, and
 * the part's own short instruction, kept inline since it is not
 * content-addressed the way the part's prose is) without inlining the
 * prose itself — that is the one potentially unbounded input a request
 * carries, so it rides as a revision reference instead, resolved on demand
 * by `server/generation-record-resolve.ts`. Splitting only at the Author's
 * Note keeps the entry count fixed no matter how deep the story runs; the
 * depth lives in `parts`, not in the top-level entry array.
 *
 * `promptEntriesInline` is for every other operation (a rewrite, a summary,
 * a chapter summary), whose prompt is a flat `PromptPlan` with no richer
 * plan behind it and whose own "source" text (a rewrite's passage, a
 * summary's fixed excerpt) is bounded to what that one request touched, not
 * the whole story — inlining it is both simple and honest. One entry per
 * original block, in order; never bucketed by kind, so two blocks that
 * happen to share a kind never collapse into one.
 */

export function continuationRecordEntries(story: Story, continuation: ContinuationPlan): GenerationRecordPromptEntry[] {
  const byId = new Map(story.nodes.map((node) => [node.id, node] as const));
  const entries: GenerationRecordPromptEntry[] = [];
  let run: GenerationRecordSourcePart[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    entries.push({ stability: "stable", kind: "source", source: "revisions", parts: run });
    run = [];
  };
  const plan = continuation.entries;
  for (let index = 0; index < plan.length; index++) {
    const planEntry = plan[index]!;
    if (planEntry.partId === undefined) {
      flushRun();
      entries.push(textEntry(planEntry.turn.role, planEntry.turn.blocks[0]!));
      continue;
    }
    // Every context part is a user instruction turn immediately followed by
    // its assistant prose turn (shared/continuation-plan.ts's own
    // `partEntries.flatMap` pairing) — never split by anything else,
    // including the Author's Note, which only ever lands between complete
    // pairs. A plan that violates this is a bug in the plan builder, not
    // untrusted input, so this fails loudly rather than silently mispairing
    // an instruction with the wrong part's prose.
    const prose = plan[index + 1];
    if (prose === undefined || prose.partId !== planEntry.partId) {
      throw new Error(`Malformed continuation plan: part ${planEntry.partId} has no matching prose turn`);
    }
    index += 1;
    const part = sourcePart(byId, planEntry);
    if (part !== null) run.push(part);
  }
  flushRun();
  return entries;
}

function sourcePart(
  byId: ReadonlyMap<string, StoryNode>,
  instructionEntry: Extract<ContinuationPromptEntry, { partId: string }>
): GenerationRecordSourcePart | null {
  const node = byId.get(instructionEntry.partId);
  // A node whose text is not yet a durable, reusable revision (freshly
  // minted within this same request, so nothing has stored it yet) is
  // omitted rather than guessed at; that is a narrow, honest gap, not a
  // fabricated reference.
  if (node === undefined || node.text.trim().length === 0) return null;
  const revisionId = reusableStoredRevisionId(node);
  if (revisionId === undefined) return null;
  return {
    nodeId: node.id,
    category: instructionEntry.category,
    instruction: instructionEntry.turn.blocks[0]!.text,
    revisionId,
    textLength: node.text.length
  };
}

export function promptEntriesInline(plan: PromptPlan): GenerationRecordPromptEntry[] {
  return plan.turns.flatMap((turn) => turn.blocks.map((block) => textEntry(turn.role, block)));
}

function textEntry(role: PromptRole, block: PromptBlock): GenerationRecordTextEntry {
  return {
    role,
    stability: block.stability,
    kind: block.kind,
    source: "text",
    text: block.text
  };
}
