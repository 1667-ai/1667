import { resolveAuthorBrief } from "../shared/author-brief.js";
import { resolveAuthorsNoteDepth, type AuthorsNotePlacement } from "../shared/authors-note.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";
import type { ChapterBreak, GenerationSettings, StoryNode } from "../shared/types.js";
import { continuationPlan, supportsAssistantPrefill, type ContinuationPlan } from "./generation-prompts.js";

export interface ContinuationAssemblyStory {
  readonly authorsNote?: string;
  readonly authorsNoteDepth?: number;
  readonly authorBrief?: string;
  readonly chapterBreaks: readonly ChapterBreak[];
  readonly nodes: readonly StoryNode[];
}

export interface ContinuationAssemblyInput {
  readonly story: ContinuationAssemblyStory;
  readonly settings: GenerationSettings;
  readonly contextParts: readonly StoryNode[];
  readonly instruction: string;
  readonly appendLast: boolean;
  readonly images: readonly StoryImageAttachment[];
}

export interface ContinuationAssembly {
  readonly authorsNote: string | null;
  readonly plan: (facts: string | null) => ContinuationPlan;
}

/** Build the production continuation prompt from one selected story context. */
export function assembleContinuation(input: ContinuationAssemblyInput): ContinuationAssembly {
  const authorsNote = input.story.authorsNote ?? null;
  const authorsNotePlacement: AuthorsNotePlacement | null = authorsNote === null
    ? null
    : { text: authorsNote, depth: resolveAuthorsNoteDepth(input.story.authorsNoteDepth) };
  const authorBrief = resolveAuthorBrief(input.story.authorBrief, input.settings.systemPrompt);
  return {
    authorsNote,
    plan: (facts) => continuationPlan(
      authorBrief,
      facts,
      authorsNotePlacement,
      input.contextParts,
      input.instruction,
      input.appendLast,
      supportsAssistantPrefill(input.settings),
      null,
      input.story.chapterBreaks as readonly ChapterBreak[],
      input.story.nodes,
      input.images
    )
  };
}
