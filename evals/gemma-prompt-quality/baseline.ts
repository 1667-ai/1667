import { createHash } from "node:crypto";
import type { PromptPlan, PromptTurn } from "../../shared/prompt-plan.js";
import { canonicalJson } from "../../server/canonical-json.js";
import type { GemmaOperationFixture } from "./fixture.js";
import { GEMMA_V08_REQUEST_SHAPE } from "./contract.js";

/** This is a source-level copy of the v0.8.0 continuation contract. Keep it
 * separate from the live plan so a future prompt edit cannot move the oracle. */
export const V08_OPERATION_CONTRACTS = Object.freeze({
  append: [
    "Continuation mode: the final assistant message is an unfinished passage.",
    "Continue directly from its exact final character, even when that character is in the middle of a sentence or word.",
    "Return only the new characters after that boundary; do not repeat, restart, quote, or summarize existing text."
  ].join(" "),
  newPassage: [
    "Write the next passage of the story in response to the final user direction.",
    "Return only story prose: no summary, explanation, or commentary."
  ].join(" ")
} as const);

/** Frozen v0.8.0 identity. This identity describes the prompt ordering and the
 * request body contract, not a model output. */
export const V08_BASELINE_IDENTITY = Object.freeze({
  version: "v0.8.0",
  ...GEMMA_V08_REQUEST_SHAPE
} as const);

/** This hash protects the frozen plan identity and operation contracts. The
 * compatibility gate separately protects frozen v0.8.0 source files. */
export const V08_BASELINE_PLAN_FINGERPRINT =
  "sha256:d4406b412cd4fa17520a10ab6ab70559f65abd70a26201a110336921a810c3c8";

export function baselinePlanFingerprint(): string {
  return `sha256:${sha256(canonicalJson({
    identity: V08_BASELINE_IDENTITY,
    contracts: V08_OPERATION_CONTRACTS
  }))}`;
}

/** Build the v0.8.0 plan without calling the current prompt builder. */
export function baselineContinuationPlan(
  operation: GemmaOperationFixture,
  authorBrief: string,
  facts: string
): PromptPlan {
  const continuePassage = operation.appendLast;
  const prelude: PromptTurn[] = [
    ...(authorBrief.trim().length === 0 ? [] : [textTurn("system", "author-brief", authorBrief, "candidate")]),
    textTurn("system", "facts", facts, "candidate"),
    textTurn(
      "system",
      "operation-contract",
      continuePassage ? V08_OPERATION_CONTRACTS.append : V08_OPERATION_CONTRACTS.newPassage,
      "candidate"
    )
  ];
  // Frozen expected output of v0.8 chapter assembly. This intentionally does
  // not call the live chapter or Author's Note helpers.
  const parts = operation.baselineContext;
  const storyTurns = parts.flatMap((part): PromptTurn[] => [
    {
      role: "user",
      blocks: [{
        stability: "stable",
        kind: "source",
        text: part.instruction.trim() || "Continue the story.",
        boundaryAfter: "none"
      }]
    },
    {
      role: "assistant",
      blocks: [{
        stability: "stable",
        kind: "source",
        text: part.text,
        boundaryAfter: "candidate"
      }]
    }
  ]);
  const partsAfterNote = Math.min(operation.authorsNote.depth, parts.length);
  const insertionIndex = storyTurns.length - 2 * partsAfterNote;
  const note: PromptTurn = {
    role: "system",
    blocks: [{
      stability: "stable",
      kind: "authors-note",
      text: operation.authorsNote.text,
      boundaryAfter: "none"
    }]
  };
  const turnsWithNote = [
    ...storyTurns.slice(0, insertionIndex),
    note,
    ...storyTurns.slice(insertionIndex).map(sealTurn)
  ];
  if (continuePassage) {
    return { operation: "continue", turns: [...prelude, ...turnsWithNote] };
  }
  return {
    operation: "continue",
    turns: [
      ...prelude,
      ...turnsWithNote,
      {
        role: "user",
        blocks: [{
          stability: "volatile",
          kind: "request",
          text: operation.instruction.trim() || "Continue the story.",
          boundaryAfter: "none"
        }]
      }
    ]
  };
}

function sealTurn(turn: PromptTurn): PromptTurn {
  return {
    ...turn,
    blocks: turn.blocks.map((block) => block.stability === "stable"
      ? { ...block, boundaryAfter: "none" }
      : block)
  };
}

/** A strict structural projection for request-shape comparison. */
export function requestShape(plan: PromptPlan): Record<string, unknown> {
  return {
    operation: plan.operation,
    roles: plan.turns.map((turn) => turn.role),
    blockKinds: plan.turns.map((turn) => turn.blocks.map((block) => block.kind)),
    finalRole: plan.turns.at(-1)?.role ?? null,
    finalBlockKind: plan.turns.at(-1)?.blocks.at(-1)?.kind ?? null
  };
}

function textTurn(
  role: PromptTurn["role"],
  kind: "author-brief" | "facts" | "operation-contract",
  text: string,
  boundaryAfter: "none" | "candidate"
): PromptTurn {
  return {
    role,
    blocks: [{ stability: "stable", kind, text, boundaryAfter }]
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
