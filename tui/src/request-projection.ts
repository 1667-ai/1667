import {
  deriveChapters,
  summaryNodeInstruction,
  SUMMARY_TARGET_TOKENS,
  type ChapterPartLike,
  type PromptPart
} from "../../shared/chapters.js";
import { continuationPlan, type ContinuationPlan } from "../../shared/continuation-plan.js";
import { resolveAuthorBrief } from "../../shared/author-brief.js";
import { selectActiveFacts } from "../../shared/fact-activation.js";
import { renderPromptPlan, type ChatMessage } from "../../shared/prompt-plan.js";
import { formatFactsMessage } from "../../shared/story-facts.js";
import { isChapterSummary } from "../../shared/story-tree.js";
import { estimateTokens } from "../../shared/tokens.js";
import { isChapterSummaryNodeStub, type StoryPayload } from "../../shared/types.js";
import { continuationIntent } from "./continuation-intent.js";

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
  activeFactIds: string[];
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
  const activeFacts = selectActiveFacts(payload.facts, {
    contextParts: intent.contextParts,
    chapterBreaks: payload.chapterBreaks,
    nodes: promptNodes(payload),
    instruction: intent.instruction
  });
  const plan = continuationPlan(
    resolveAuthorBrief(payload.authorBrief, request.systemPrompt),
    formatFactsMessage(activeFacts),
    payload.authorsNote ?? null,
    intent.contextParts,
    intent.instruction,
    intent.appendLast,
    request.assistantPrefill,
    null,
    payload.chapterBreaks,
    promptNodes(payload)
  );
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
    activeFactIds: activeFacts.map((fact) => fact.id)
  };
}

function promptNodes(payload: StoryPayload): PromptPart[] {
  return payload.nodes.filter(isChapterSummaryNodeStub);
}

function messageTokens(content: string): number {
  return estimateTokens(content) + 4;
}
