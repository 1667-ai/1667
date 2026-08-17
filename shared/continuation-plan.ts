import { assembleChapterContext, type PromptPart } from "./chapters.js";
import { normalizeAuthorsNote, type AuthorsNotePlacement } from "./authors-note.js";
import type { PromptBlock, PromptPlan, PromptTurn } from "./prompt-plan.js";
import type { ContinuationPromptLayout } from "./continuation-prompt-optimization.js";
import { isOfficialAnthropicBaseUrl } from "./settings-provider-defaults.js";
import type { StoryImageAttachment } from "./image-attachment.js";
import type { ChapterBreak, GenerationSettings, StoryNode } from "./types.js";

export const DEFAULT_INSTRUCTION = "Continue the story.";
export const BOUNDARY_ANCHOR_CHARACTERS = 24;

export { CONTINUATION_PROMPT_LAYOUTS } from "./continuation-prompt-optimization.js";
export type { ContinuationPromptLayout } from "./continuation-prompt-optimization.js";

const APPEND_CONTRACT = [
  "Continuation mode: the final assistant message is an unfinished passage.",
  "Continue directly from its exact final character, even when that character is in the middle of a sentence or word.",
  "Return only the new characters after that boundary; do not repeat, restart, quote, or summarize existing text."
].join(" ");

const CONTINUE_CONTRACT = [
  "Write the next passage of the story in response to the final user direction.",
  "Return only story prose: no summary, explanation, or commentary."
].join(" ");

const PREFILL_CONTINUITY_GUARD = "Preserve the established point of view and tense.";

export type ContinuationPromptEntry =
  | { category: "voice" | "facts"; turn: PromptTurn; partId?: never }
  /** `partsAfterNote` is the placement the plan really used, which is the
   *  requested depth clamped to the parts available. It is 0 when the note
   *  precedes the request itself, a placement no stored depth can name. */
  | { category: "note"; turn: PromptTurn; partId?: never; partsAfterNote: number }
  | { category: "recent" | "summary"; turn: PromptTurn; partId: string };

type PartPromptEntry = Extract<ContinuationPromptEntry, { partId: string }>;

export interface ContinuationPlan {
  prompt: PromptPlan;
  entries: ContinuationPromptEntry[];
  /** Structural context after chapter-summary replacement, including empty endpoints. */
  contextPartIds: string[];
  leftAnchor: string;
  requiresEcho: boolean;
}

/** Build ordinary chat history, or leave the existing assistant passage last so
 * compatible backends continue its token stream instead of starting a new turn. */
export function continuationPlan(
  systemPrompt: string,
  facts: string | null,
  authorsNote: AuthorsNotePlacement | null,
  parts: readonly StoryNode[],
  instruction: string,
  appendLast: boolean,
  assistantPrefill: boolean,
  tag: string | null,
  chapterBreaks: readonly ChapterBreak[],
  nodes: readonly PromptPart[],
  /** Images attached to the request being generated, not to any existing
   *  story part. Ordered as the writer attached them. A request that carries
   *  one always opens a new-passage user turn: no assistant prefill, no
   *  boundary echo.
   *
   *  The caller resolves the ordered `{leaseId, objectId}` pairs on the
   *  continueStory input envelope into `StoryImageAttachment` values and
   *  passes them here. It also refuses a request that combines a non-empty
   *  `newImages` list with `appendTo !== null`: an append mutates an existing
   *  part, and a stored part records the exact provider input it was
   *  generated from, so a new image can only ever start a new child
   *  take. This function forces the new-passage turn either way; it cannot
   *  refuse the append itself because it never sees `appendTo`. */
  newImages: readonly StoryImageAttachment[] = [],
  layout: ContinuationPromptLayout = "compatibility"
): ContinuationPlan {
  const note = authorsNote === null ? null : normalizeAuthorsNote(authorsNote.text);
  const sourceContext = assembleChapterContext(parts, chapterBreaks, nodes);
  const contextPartIds = sourceContext.map((part) => part.id);
  const continuePassage = appendLast
    && newImages.length === 0
    && (sourceContext.at(-1)?.text.trim().length ?? 0) > 0;
  // Migrated empty endpoints are structural line endings, not provider messages.
  const context = sourceContext.filter((part) => part.text.trim().length > 0);
  const prelude: ContinuationPromptEntry[] = [
    ...(systemPrompt.trim().length === 0 ? [] : [{
      category: "voice" as const,
      turn: {
        role: "system" as const,
        blocks: [{
          stability: "stable" as const,
          kind: "author-brief" as const,
          text: systemPrompt,
          boundaryAfter: "candidate" as const
        }]
      }
    }]),
    // Canonical facts ride as their own system message in every operation.
    ...(facts === null ? [] : [{
      category: "facts" as const,
      turn: {
        role: "system" as const,
        blocks: [{
          stability: "stable" as const,
          kind: "facts" as const,
          text: facts,
          boundaryAfter: "candidate" as const
        }]
      }
    }]),
    ...(layout === "compatibility" ? [{
      category: "voice" as const,
      turn: {
        role: "system" as const,
        blocks: [{
          stability: "stable" as const,
          kind: "operation-contract" as const,
          text: continuePassage ? APPEND_CONTRACT : CONTINUE_CONTRACT,
          boundaryAfter: "candidate" as const
        }]
      }
    }] : []),
  ];
  const partEntries: PartPromptEntry[] = context.flatMap((part, index): PartPromptEntry[] => {
      const category = part.role === "summary" ? "summary" as const : "recent" as const;
      const images = partImageAttachments(part);
      const carriesPrefillContinuityGuard = layout === "late-cache-stable"
        && continuePassage
        && assistantPrefill
        && index === context.length - 1;
      return [
        { category, turn: {
          role: "user",
          blocks: [
            ...images.map((image) => ({
              stability: "stable" as const,
              kind: "image" as const,
              image,
              boundaryAfter: "none" as const
            })),
            {
              stability: "stable" as const,
              kind: "source" as const,
              text: part.instruction.trim() || DEFAULT_INSTRUCTION,
              boundaryAfter: "none" as const
            },
            ...(carriesPrefillContinuityGuard ? [{
              stability: "stable" as const,
              kind: "operation-contract" as const,
              text: `\n\n${PREFILL_CONTINUITY_GUARD}`,
              boundaryAfter: "none" as const
            }] : [])
          ]
        }, partId: part.id },
        { category, turn: {
          role: "assistant",
          blocks: [{
            stability: "stable",
            kind: "source",
            text: part.text,
            boundaryAfter: "candidate"
          }]
        }, partId: part.id }
      ];
    });
  // Each part is a user/assistant pair, so the index stays even and the entry
  // right after the note is always a user turn. A depth past the available
  // parts clamps to the start, right after the prelude.
  const partsAfterNote = Math.min(authorsNote?.depth ?? 0, partEntries.length / 2);
  const insertionIndex = partEntries.length - 2 * partsAfterNote;
  const entries: ContinuationPromptEntry[] = note === null
    ? [...prelude, ...partEntries]
    : [
        ...prelude,
        ...partEntries.slice(0, insertionIndex),
        {
          category: "note",
          turn: {
            role: "system",
            blocks: [{
              stability: "stable",
              kind: "authors-note",
              text: note,
              boundaryAfter: "none"
            }]
          },
          partsAfterNote
        },
        ...partEntries.slice(insertionIndex).map(sealPartEntry)
      ];
  if (!continuePassage) {
    entries.push({
      category: "voice",
      turn: {
        role: "user",
        blocks: [
          ...(layout === "late-cache-stable" ? [operationContractBlock(CONTINUE_CONTRACT)] : []),
          ...newImages.map((image) => ({
            stability: "volatile" as const,
            kind: "image" as const,
            image,
            boundaryAfter: "none" as const
          })),
          {
            stability: "volatile" as const,
            kind: "request" as const,
            text: instruction.trim().length === 0 ? DEFAULT_INSTRUCTION : instruction,
            boundaryAfter: "none" as const
          }
        ]
      }
    });
    assertAuthorsNoteFollowedByUser(entries);
    return continuationResult(entries, contextPartIds, "", false);
  }
  if (assistantPrefill) {
    assertAuthorsNoteFollowedByUser(entries);
    return continuationResult(entries, contextPartIds, "", false);
  }

  const leftAnchor = lastCharacters(context.at(-1)?.text.trimEnd() ?? "", BOUNDARY_ANCHOR_CHARACTERS);
  let boundaryInstruction = "Continue the unfinished assistant passage directly. Return only new continuation text, with no preamble or explanation.";
  if (leftAnchor.length > 0) {
    const boundaryTag = tag ?? deriveBoundaryTag(leftAnchor);
    boundaryInstruction = [
      "Continue the unfinished assistant passage from its exact final character.",
      "Start your response by copying the LEFT BOUNDARY text below byte-for-byte, then write only the new continuation after it.",
      "Do not restart, summarize, quote, or explain the passage.",
      "",
      `<${boundaryTag}-left>${leftAnchor}</${boundaryTag}-left>`
    ].join("\n");
  }
  entries.push({
    category: "voice",
    turn: {
      role: "user",
      blocks: [
        ...(layout === "late-cache-stable" ? [operationContractBlock(APPEND_CONTRACT)] : []),
        {
          stability: "volatile",
          kind: "boundary",
          text: boundaryInstruction,
          boundaryAfter: "none"
        }
      ]
    }
  });
  assertAuthorsNoteFollowedByUser(entries);
  return continuationResult(entries, contextPartIds, leftAnchor, leftAnchor.length > 0);
}

/** Keep the operation-specific late contract in the final user turn. Some
 * local chat templates reject a system turn after story assistant turns. */
function operationContractBlock(text: string): PromptBlock {
  return {
    stability: "stable",
    kind: "operation-contract",
    text: `${text}\n\n`,
    boundaryAfter: "none"
  };
}

function sealPartEntry(entry: PartPromptEntry): PartPromptEntry {
  return {
    ...entry,
    turn: {
      ...entry.turn,
      blocks: entry.turn.blocks.map((block) =>
        block.stability === "stable"
          ? { ...block, boundaryAfter: "none" }
          : block
      )
    }
  };
}

function assertAuthorsNoteFollowedByUser(entries: readonly ContinuationPromptEntry[]): void {
  const noteIndex = entries.findIndex((entry) => entry.category === "note");
  if (noteIndex === -1) return;
  if (entries[noteIndex + 1]?.turn.role !== "user") {
    throw new Error("Author's Note must be followed by a user turn");
  }
}

function continuationResult(
  entries: ContinuationPromptEntry[],
  contextPartIds: string[],
  leftAnchor: string,
  requiresEcho: boolean
): ContinuationPlan {
  return {
    prompt: { operation: "continue", turns: entries.map((entry) => entry.turn) },
    entries,
    contextPartIds,
    leftAnchor,
    requiresEcho
  };
}

/** OpenAI documents assistant entries as previous messages, not response prefills;
 * Claude 4.6+ rejects prefills. Those APIs use the exact-boundary echo fallback. */
export function supportsAssistantPrefill(settings: GenerationSettings): boolean {
  const runtime = (
    settings as GenerationSettings & {
      [key: symbol]: {
        protocol?: "dry-run" | "openai-chat-completions" | "text-completions" | "anthropic-messages";
        capabilities?: { assistantPrefill?: "supported" | "unsupported" | "unknown" };
      } | undefined;
    }
  )[Symbol.for("1667.provider-runtime")];
  if (runtime?.protocol === "text-completions" || settings.provider === "text-completion") {
    return true;
  }
  if (
    settings.provider === "anthropic"
    && isOfficialAnthropicBaseUrl(settings.baseUrl)
    && isClaudeWithoutPrefill(settings.model)
  ) return false;
  if (settings.provider === "openai-compatible") {
    try {
      const hostname = new URL(settings.baseUrl).hostname.toLowerCase();
      if (hostname === "api.openai.com" || hostname.endsWith(".openai.azure.com")) {
        return false;
      }
    } catch {
      // Invalid URLs are rejected by provider admission; preserve legacy fallback here.
    }
  }
  const declared = runtime?.capabilities?.assistantPrefill;
  if (declared === "supported") return true;
  if (declared === "unsupported") return false;
  if (settings.provider === "openai-compatible") return true;
  if (settings.provider !== "anthropic") return true;
  const familyFirst = /^claude-(?:opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(settings.model);
  const versionFirst = /^claude-(\d+)(?:[-.](\d+))?/i.exec(settings.model);
  const version = familyFirst ?? versionFirst;
  if (version === null) return false;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  return major < 4 || (major === 4 && minor <= 5);
}

function isClaudeWithoutPrefill(model: string): boolean {
  const familyFirst = /^claude-(?:opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(model);
  const versionFirst = /^claude-(\d+)(?:[-.](\d+))?/i.exec(model);
  const version = familyFirst ?? versionFirst;
  if (version === null) return false;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 6);
}

/** A story part's own Image Attachments, when it has any. Chapter-summary
 *  parts (`PromptPart`) never carry one: a summary replaces the images along
 *  with the prose it replaces, which is how images live and die with normal
 *  context substitution. */
function partImageAttachments(part: StoryNode | PromptPart): readonly StoryImageAttachment[] {
  return "imageAttachments" in part && part.imageAttachments !== undefined
    ? part.imageAttachments
    : [];
}

function lastCharacters(value: string, count: number): string {
  return Array.from(value).slice(-count).join("");
}

function deriveBoundaryTag(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 0x01000193);
  }
  return `ct-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
