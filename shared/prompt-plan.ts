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

export type PromptBlock = StablePromptBlock | VolatilePromptBlock;

export interface PromptTurn {
  readonly role: PromptRole;
  readonly blocks: readonly PromptBlock[];
}

export interface PromptPlan {
  readonly operation: PromptOperation;
  readonly turns: readonly PromptTurn[];
}

/** Render the current string-message wire shape without inventing separators.
 * Protocol adapters can inspect the same blocks when cache lowering lands. */
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
    .map((block) => block.text);
}

function renderTurns(turns: readonly PromptTurn[]): ChatMessage[] {
  let volatile = false;
  return turns.map((turn) => {
    if (turn.blocks.length === 0) throw new Error("Prompt turns cannot be empty");
    return {
      role: turn.role,
      content: turn.blocks.map((block) => {
        if (block.text.length === 0) throw new Error("Prompt blocks cannot be empty");
        if (block.stability === "volatile") {
          volatile = true;
        } else if (volatile) {
          throw new Error("Stable prompt content cannot follow volatile content");
        }
        return block.text;
      }).join("")
    };
  });
}
