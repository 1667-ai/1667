import { assembleChapterContext, type PromptPart } from "./chapters.js";
import { normalizeAuthorsNote, type AuthorsNotePlacement } from "./authors-note.js";
import type { PromptPlan, PromptTurn } from "./prompt-plan.js";
import { isOfficialAnthropicBaseUrl } from "./settings-provider-defaults.js";
import type { StoryImageAttachment } from "./image-attachment.js";
import type { ChapterBreak, GenerationSettings, StoryNode } from "./types.js";

export const DEFAULT_INSTRUCTION = "Continue the story.";
export const BOUNDARY_ANCHOR_CHARACTERS = 24;

const APPEND_CONTRACT = [
  "Continuation mode: the final assistant message is an unfinished passage.",
  "Continue directly from its exact final character, even when that character is in the middle of a sentence or word.",
  "Return only the new characters after that boundary; do not repeat, restart, quote, or summarize existing text."
].join(" ");

const CONTINUE_CONTRACT = [
  "Write the next passage of the story in response to the final user direction.",
  "Return only story prose: no summary, explanation, or commentary."
].join(" ");

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
  newImages: readonly StoryImageAttachment[] = []
): ContinuationPlan {
  const note = authorsNote === null ? null : normalizeAuthorsNote(authorsNote.text);
  const sourceContext = assembleChapterContext(parts, chapterBreaks, nodes);
  const contextPartIds = sourceContext.map((part) => part.id);
  const continuePassage = appendLast
    && newImages.length === 0
    && (sourceContext.at(-1)?.text.trim().length ?? 0) > 0;
  // Migrated empty endpoints are structural line endings, not provider messages.
  const context = sourceContext.filter((part) => part.text.trim().length > 0);
  // The operation contract used to ride here, as the third message ahead of
  // every story part. Its text depends on `continuePassage`, so a prelude
  // that carried it changed on every switch between continuing a passage and
  // starting a new part — the one thing a local server's KV cache needs held
  // constant to reuse the (potentially huge) unchanged story prefix. It now
  // rides near the end instead, via `appendOperationContract` below, so the
  // prelude here is the same bytes regardless of which way the request goes.
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
  ];
  const partEntries: PartPromptEntry[] = context.flatMap((part): PartPromptEntry[] => {
      const category = part.role === "summary" ? "summary" as const : "recent" as const;
      const images = partImageAttachments(part);
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
            }
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
    const withContract = appendOperationContract(entries, CONTINUE_CONTRACT);
    withContract.push({
      category: "voice",
      turn: {
        role: "user",
        blocks: [
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
    assertAuthorsNoteFollowedByUser(withContract);
    return continuationResult(withContract, contextPartIds, "", false);
  }
  if (assistantPrefill) {
    // A prefilled continuation ends with the story's own unfinished assistant
    // message, unchanged, so the provider can extend that exact token stream
    // — nothing can follow it without turning the completion into a fresh
    // turn instead of a continuation. Any contract message would have to
    // land either after that passage (breaking the prefill) or ahead of it
    // (reopening the same prefix instability this function exists to close).
    // The instruction is not lost: the prefill mechanism itself already
    // enforces exact, unprefaced continuation, which is what the contract
    // text would otherwise have to say. See shared/continuation-plan.ts's
    // module comment / issue #138 for the full reasoning.
    assertAuthorsNoteFollowedByUser(entries);
    return continuationResult(entries, contextPartIds, "", false);
  }

  const withContract = appendOperationContract(entries, APPEND_CONTRACT);
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
  withContract.push({
    category: "voice",
    turn: {
      role: "user",
      blocks: [{
        stability: "volatile",
        kind: "boundary",
        text: boundaryInstruction,
        boundaryAfter: "none"
      }]
    }
  });
  assertAuthorsNoteFollowedByUser(withContract);
  return continuationResult(withContract, contextPartIds, leftAnchor, leftAnchor.length > 0);
}

/** Place the operation contract as the last stable message, immediately
 *  ahead of whatever volatile turn the caller pushes next (the new-part
 *  instruction, or the boundary echo) — after every story part, instead of
 *  ahead of all of them, so its mode-dependent text no longer sits in the
 *  part of the prompt a local server's KV cache needs unchanged to reuse the
 *  story it already processed (issue #138).
 *
 *  One placement cannot honor "immediately ahead of the final turn" literally:
 *  when an Author's Note has clamped to zero trailing parts, it is already
 *  the entry the following user turn must land on directly
 *  (`assertAuthorsNoteFollowedByUser`), and the contract — a system turn —
 *  cannot wedge between them without breaking that fold. It lands just ahead
 *  of the note instead, which is the latest position that still respects the
 *  fold.
 *
 *  Its own `boundaryAfter` stays `"none"`, deliberately not a candidate
 *  OpenAI cache breakpoint: unlike a story part, whose trailing hash is
 *  fixed forever once written, this block's hash is recomputed over the
 *  whole growing story on every request. Marking it a candidate would make
 *  it "the newest" every single time, and since that hash never recurs once
 *  the story grows by even one part, the *previous* request's remembered
 *  breakpoint would never be found again — trading away the rolling,
 *  warm-cache reuse `server/prompt-cache-breakpoints.ts` otherwise gets for
 *  free from a part boundary that never moves once it exists. */
function appendOperationContract(
  entries: readonly ContinuationPromptEntry[],
  text: string
): ContinuationPromptEntry[] {
  const contractEntry: ContinuationPromptEntry = {
    category: "voice",
    turn: {
      role: "system",
      blocks: [{
        stability: "stable",
        kind: "operation-contract",
        text,
        boundaryAfter: "none"
      }]
    }
  };
  const last = entries.at(-1);
  if (last !== undefined && last.category === "note") {
    return [...entries.slice(0, -1), contractEntry, last];
  }
  return [...entries, contractEntry];
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
