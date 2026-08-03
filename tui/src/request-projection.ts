import {
  deriveChapters,
  summaryNodeInstruction,
  SUMMARY_TARGET_TOKENS,
  type ChapterPartLike,
  type PromptPart
} from "../../shared/chapters.js";
import { continuationPlan, type ContinuationPlan } from "../../shared/continuation-plan.js";
import { resolveAuthorBrief } from "../../shared/author-brief.js";
import { resolveAuthorsNoteDepth, type AuthorsNotePlacement } from "../../shared/authors-note.js";
import { previewFixedContextAdmission } from "../../shared/fact-admission.js";
import type { FactBudgetDrop } from "../../shared/fact-budget.js";
import { renderPromptPlan, type ChatMessage } from "../../shared/prompt-plan.js";
import { activeBudgetedFacts } from "../../shared/fact-selection.js";
import { isChapterSummary } from "../../shared/story-tree.js";
import { estimateTokens } from "../../shared/tokens.js";
import { isChapterSummaryNodeStub, type StoryPayload } from "../../shared/types.js";
import { continuationIntent } from "./continuation-intent.js";
import { factRequestStatuses, type FactRequestStatus } from "./facts-model.js";

export interface ContextBreakdown {
  voice: number;
  facts: number;
  recent: number;
  summary: number;
  note: number;
}

export interface RequestTokenEstimate {
  tokens: number;
  breakdown: ContextBreakdown;
  chapters: RequestChapterProjection[];
  /** Sent, not-matched, or dropped-with-reason, for every Fact in the story —
   *  see tui/src/facts-model.ts. Replaces a plain "is it active" boolean,
   *  which could not tell a Fact that never matched from one the budget shed. */
  factStatuses: ReadonlyMap<string, FactRequestStatus>;
  /** Every Fact that will not reach the provider: shed by the story's own
   *  Facts budget, by a Fact's own budgetTokens cap, or — previewed here via
   *  `previewFixedContextAdmission` (shared/fact-admission.ts), the same
   *  selection server/generation-admission.ts's `assertFixedContextFits` runs
   *  on the real request — by model-context-window pressure. A comment here
   *  used to say window pressure was a server-only last resort this meter
   *  could not preview; that was true only because the two selections had not
   *  yet been shared (issue #281 review finding H), and it made the meter,
   *  the Facts panel, and the request viewer all describe a prompt that was
   *  not the one sent. */
  droppedFacts: readonly FactBudgetDrop[];
}

export interface NextRequestEstimate extends RequestTokenEstimate {
  readonly plan: ContinuationPlan;
  readonly messages: readonly ChatMessage[];
  /** Token estimates aligned one-to-one with messages and plan entries. */
  readonly messageTokenCounts: readonly number[];
  readonly substitutions: readonly RequestSubstitutionProjection[];
}

export type RequestSubstitutionProjection =
  | { kind: "legacy-summary"; summaryId: string; omittedPartCount: number }
  | {
      kind: "chapter-summary";
      chapterNumber: number;
      summaryId: string;
      tokens: number;
      replacedPartIds: readonly string[];
    };

/** Chapter state scoped to the exact structural context in this request. */
export interface RequestChapterProjection {
  number: number;
  included: boolean;
  /** Exact provider-message tokens contributed by this chapter. */
  tokens: number;
  closed: boolean;
  summarized: boolean;
  stale: boolean;
  /** Provider-message tokens a fresh summary would remove from this request. */
  savings: number;
}

interface NextRequestBaseContext {
  systemPrompt: string;
  /** Current COMPOSE draft; NAV passes an empty string for an empty Continue. */
  instruction: string;
  assistantPrefill: boolean;
  /** The configured model window and output cap — the same two settings
   *  fields server/generation-admission.ts reads to decide whether Facts
   *  need to be shed for window pressure. Required so that decision can be
   *  previewed here rather than guessed at (see droppedFacts above). */
  contextWindow: number | null;
  maxTokens: number;
}

export type NextRequestContext = NextRequestBaseContext & (
  | {
      operation: "continue";
      /** Focused path node; older nodes generate from that seam. */
      targetId: string | null;
    }
  | {
      operation: "retake";
      /** Exact prompted-retake session target. */
      targetId: string;
    }
);

/** Build the same shared continuation plan the server sends, then explain its
 * exact estimate as voice/facts/note/recent/summary slices. */
export function nextRequestEstimate(payload: StoryPayload, request: NextRequestContext): NextRequestEstimate {
  const regenerateNode = request.operation === "continue"
    ? null
    : payload.path.find((node) => node.id === request.targetId) ?? null;
  const intent = continuationIntent(payload, request.targetId, request.instruction, regenerateNode);
  // The same candidate selection shared/fact-selection.ts's activeBudgetedFacts
  // runs for a real request — StoryPayload satisfies its structural
  // FactsBudgetSource parameter the same way Story does, so this meter's
  // candidate list is that function's result rather than a second hand-rolled
  // copy of it that could drift from the request (issue #316).
  const budgetedFacts = activeBudgetedFacts(payload, {
    contextParts: intent.contextParts,
    chapterBreaks: payload.chapterBreaks,
    nodes: promptNodes(payload),
    instruction: intent.instruction
  });
  const authorsNotePlacement: AuthorsNotePlacement | null = payload.authorsNote === undefined
    ? null
    : { text: payload.authorsNote, depth: resolveAuthorsNoteDepth(payload.authorsNoteDepth) };
  const buildPlan = (factsMessage: string | null): ContinuationPlan => continuationPlan(
    resolveAuthorBrief(payload.authorBrief, request.systemPrompt),
    factsMessage,
    authorsNotePlacement,
    intent.contextParts,
    intent.instruction,
    intent.appendLast,
    request.assistantPrefill,
    null,
    payload.chapterBreaks,
    promptNodes(payload)
  );
  // The same window-pressure selection server/generation-admission.ts's
  // assertFixedContextFits runs on the real request (shared/fact-admission.ts's
  // selectFactsForFixedContext), previewed here rather than sent — see
  // previewFixedContextAdmission. Reusing that function (not just its
  // arithmetic) is what keeps this meter from describing a prompt the server
  // would not actually send.
  const { plan, admission: windowAdmission } = previewFixedContextAdmission(
    { contextWindow: request.contextWindow, maxTokens: request.maxTokens },
    budgetedFacts.kept,
    payload.authorsNote ?? null,
    buildPlan
  );
  // windowAdmission.dropped can only add "priority" (window-pressure) drops:
  // its own-cap re-check runs against budgetedFacts.kept, which is already
  // under every Fact's own cap, so it never finds a new own-cap drop there.
  const droppedFacts = [...budgetedFacts.dropped, ...windowAdmission.dropped];
  const breakdown: ContextBreakdown = { voice: 0, facts: 0, recent: 0, summary: 0, note: 0 };
  const tokensByPart = new Map<string, number>();
  const messages = renderPromptPlan(plan.prompt);
  const messageTokenCounts = messages.map((message) => messageTokens(message.content));
  for (let index = 0; index < plan.entries.length; index += 1) {
    const entry = plan.entries[index]!;
    const tokens = messageTokenCounts[index]!;
    breakdown[entry.category] += tokens;
    if (entry.category !== "recent" && entry.category !== "summary") continue;
    tokensByPart.set(entry.partId, (tokensByPart.get(entry.partId) ?? 0) + tokens);
  }
  const structuralPartIds = new Set(plan.contextPartIds);
  const stubById = new Map(payload.nodes.map((node) => [node.id, node] as const));
  const chapterPath = payload.path.map((node) => ({ ...node, tokens: stubById.get(node.id)?.tokens }));
  const summaryRequestTokens = messageTokens(summaryNodeInstruction(payload.title)) + SUMMARY_TARGET_TOKENS + 4;
  const derivedChapters = deriveChapters<ChapterPartLike>(
    chapterPath, payload.chapterBreaks, payload.nodes
  );
  const chapters = derivedChapters.map((chapter): RequestChapterProjection => {
      const rawTokens = chapter.parts.reduce((sum, part) => sum + (tokensByPart.get(part.id) ?? 0), 0);
      const summaryTokens = chapter.summary === null ? 0 : tokensByPart.get(chapter.summary.id) ?? 0;
      const tokens = rawTokens + summaryTokens;
      const summaryIncluded = chapter.summary !== null && structuralPartIds.has(chapter.summary.id);
      const closed = chapter.closedBy !== null
        && (structuralPartIds.has(chapter.closedBy.parentPartId) || summaryIncluded);
      return {
        number: chapter.number,
        included: tokens > 0,
        tokens,
        closed,
        summarized: summaryIncluded,
        stale: summaryIncluded && chapter.stale,
        savings: closed && !summaryIncluded ? Math.max(0, rawTokens - summaryRequestTokens) : 0
      };
    });
  const substitutions: RequestSubstitutionProjection[] = [];
  const reset = payload.path.findLastIndex(
    (node) => node.role === "summary" && !isChapterSummary(node)
      && structuralPartIds.has(node.id)
  );
  if (reset >= 0) {
    substitutions.push({
      kind: "legacy-summary",
      summaryId: payload.path[reset]!.id,
      omittedPartCount: reset
    });
  }
  for (const [index, chapter] of derivedChapters.entries()) {
    const projection = chapters[index]!;
    if (!projection.summarized || chapter.summary === null) continue;
    substitutions.push({
      kind: "chapter-summary",
      chapterNumber: chapter.number,
      summaryId: chapter.summary.id,
      tokens: projection.tokens,
      replacedPartIds: chapter.parts.map((part) => part.id)
    });
  }
  return {
    plan,
    messages,
    messageTokenCounts,
    substitutions,
    tokens: Object.values(breakdown).reduce((sum, tokens) => sum + tokens, 0),
    breakdown,
    chapters,
    // A Fact counts as "matched" once it reached the budget selection at all —
    // kept or shed by it — regardless of whether window pressure later shed
    // it too; only a Fact that never matched activation in the first place is
    // "not-matched" (see factRequestStatuses).
    factStatuses: factRequestStatuses(
      payload.facts,
      new Set([
        ...budgetedFacts.kept.map((fact) => fact.id),
        ...budgetedFacts.dropped.map((drop) => drop.factId)
      ]),
      droppedFacts
    ),
    droppedFacts
  };
}

function promptNodes(payload: StoryPayload): PromptPart[] {
  return payload.nodes.filter(isChapterSummaryNodeStub);
}

function messageTokens(content: string): number {
  return estimateTokens(content) + 4;
}
