import type { StoryImageAttachment } from "./image-attachment.js";

export type PromptOperation = "continue" | "rewrite" | "title" | "summary";
export type PromptRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: PromptRole;
  content: string;
}

export type StablePromptBlockKind =
  | "author-brief"
  | "facts"
  | "operation-contract"
  | "source"
  | "authors-note";

export type VolatilePromptBlockKind =
  | "request"
  | "selection"
  | "boundary"
  | "completion-marker";

export interface StablePromptBlock {
  readonly stability: "stable";
  readonly kind: StablePromptBlockKind;
  readonly text: string;
  readonly boundaryAfter: "none" | "candidate";
}

export interface VolatilePromptBlock {
  readonly stability: "volatile";
  readonly kind: VolatilePromptBlockKind;
  readonly text: string;
  readonly boundaryAfter: "none";
}

/** An Image Attachment carried by a prompt turn. A block on an earlier story
 *  part is stable. A block on the request being generated is volatile. This
 *  block has no `text` field on purpose: TypeScript then flags every reader
 *  that expected one, and fixing those readers is the complete change list
 *  for adding image support. `boundaryAfter` can only be `"none"`, so a cache
 *  breakpoint can never land on an image block. */
export interface ImagePromptBlock {
  readonly stability: "stable" | "volatile";
  readonly kind: "image";
  readonly image: StoryImageAttachment;
  readonly boundaryAfter: "none";
}

export type PromptBlock = StablePromptBlock | VolatilePromptBlock | ImagePromptBlock;

export interface PromptTurn {
  readonly role: PromptRole;
  readonly blocks: readonly PromptBlock[];
}

export interface PromptPlan {
  readonly operation: PromptOperation;
  readonly turns: readonly PromptTurn[];
}

/** Render the current string-message wire shape without inventing separators.
 * An image block contributes no text here: its bytes never reach this
 * projection. Only the adapters in server/provider-request-body.ts read
 * `block.image`, after local admission has run. */
export function renderPromptPlan(plan: PromptPlan): ChatMessage[] {
  return renderTurns(plan.turns);
}

/** Non-story text used by conservative fixed-context admission checks. */
export function fixedPromptTexts(plan: PromptPlan): string[] {
  return plan.turns.flatMap((turn) => turn.blocks)
    .filter((block) =>
      block.kind !== "facts"
      && block.kind !== "authors-note"
      && block.kind !== "source"
      && block.kind !== "selection")
    .flatMap((block) => block.kind === "image" ? [] : [block.text]);
}

/** Every Image Attachment carried by the plan, in prompt order. Admission
 *  uses this to check the whole active-prompt image budget before a request
 *  reaches a provider. */
export function activeImageAttachments(plan: PromptPlan): readonly StoryImageAttachment[] {
  return plan.turns
    .flatMap((turn) => turn.blocks)
    .flatMap((block) => block.kind === "image" ? [block.image] : []);
}

function renderTurns(turns: readonly PromptTurn[]): ChatMessage[] {
  let volatile = false;
  return turns.map((turn) => {
    if (turn.blocks.length === 0) throw new Error("Prompt turns cannot be empty");
    const textParts: string[] = [];
    for (const block of turn.blocks) {
      if (block.kind !== "image" && block.text.length === 0) {
        throw new Error("Prompt blocks cannot be empty");
      }
      if (block.stability === "volatile") {
        volatile = true;
      } else if (volatile) {
        throw new Error("Stable prompt content cannot follow volatile content");
      }
      if (block.kind !== "image") textParts.push(block.text);
    }
    // A turn made only of image blocks renders no text. That is never valid:
    // every turn must give the model something to read.
    const content = textParts.join("");
    if (content.length === 0) throw new Error("Prompt turns cannot be empty");
    return { role: turn.role, content };
  });
}
