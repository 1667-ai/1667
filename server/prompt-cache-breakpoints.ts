import { createHash, type Hash } from "node:crypto";
import type { PromptPlan } from "../shared/prompt-plan.js";
import type { PromptTokenCounter } from "./openai-prompt-tokenizer.js";

const BOUNDARY_HASH_DOMAIN = "1667-openai-cache-boundary-v1\0";
export const DEFAULT_PROMPT_CACHE_SCOPE_LIMIT = 256;

export interface PromptBlockLocation {
  readonly turn: number;
  readonly block: number;
}

export interface PromptCacheBoundary {
  readonly hash: string;
  readonly location: PromptBlockLocation;
}

export interface PlannedPromptCacheBreakpoints {
  readonly locations: readonly PromptBlockLocation[];
  readonly newestBoundaryHash: string | null;
}

/** Process-local, content-free LRU. StoryService owns one instance so tests,
 * shutdown, and data-directory lifetime never share rolling cache state. */
export class PromptCacheBreakpointRegistry {
  private readonly entries = new Map<string, string>();

  constructor(readonly capacity = DEFAULT_PROMPT_CACHE_SCOPE_LIMIT) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error("Prompt-cache registry capacity must be a positive safe integer");
    }
  }

  previous(scope: string): string | null {
    return this.entries.get(scope) ?? null;
  }

  commit(scope: string, boundaryHash: string): void {
    if (scope.length === 0 || boundaryHash.length === 0) {
      throw new Error("Prompt-cache registry keys and boundary hashes cannot be empty");
    }
    this.entries.delete(scope);
    this.entries.set(scope, boundaryHash);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Hash-only evidence for bounded-state tests and diagnostics. */
  hashes(): readonly string[] {
    return [...this.entries.values()];
  }
}

export function planRollingOpenAiBreakpoints(
  prompt: PromptPlan,
  previousBoundaryHash: string | null,
  minimumTokens: number,
  maximumBreakpoints: number,
  countTokens: PromptTokenCounter
): PlannedPromptCacheBreakpoints {
  if (maximumBreakpoints <= 0) return { locations: [], newestBoundaryHash: null };
  const candidates = promptCacheBoundaries(prompt);
  const newest = candidates.at(-1);
  const previous = previousBoundaryHash === null
    ? undefined
    : candidates.find((candidate) => candidate.hash === previousBoundaryHash);
  if (newest === undefined) {
    return {
      locations: previous === undefined ? [] : [previous.location],
      newestBoundaryHash: null
    };
  }
  if (previous?.hash === newest.hash) {
    // Registry entries were token-qualified before their provider-admission
    // commit. Reusing an unchanged stable prefix must not synchronously
    // tokenize the same potentially multi-mebibyte text again.
    return { locations: [newest.location], newestBoundaryHash: newest.hash };
  }

  const newestEligible = exactPrefixTokenCount(prompt, newest.location, countTokens);
  const canAddNewest = newestEligible !== null && newestEligible >= minimumTokens;
  if (!canAddNewest) {
    return {
      locations: previous === undefined ? [] : [previous.location],
      newestBoundaryHash: null
    };
  }
  if (previous === undefined) {
    return { locations: [newest.location], newestBoundaryHash: newest.hash };
  }
  if (maximumBreakpoints < 2) {
    return { locations: [previous.location], newestBoundaryHash: null };
  }
  return {
    locations: [previous.location, newest.location],
    newestBoundaryHash: newest.hash
  };
}

export function lastStablePromptBoundary(prompt: PromptPlan): PromptBlockLocation | null {
  return promptCacheBoundaries(prompt).at(-1)?.location ?? null;
}

export function promptCacheBoundaries(prompt: PromptPlan): readonly PromptCacheBoundary[] {
  const boundaries: PromptCacheBoundary[] = [];
  const hash = createHash("sha256").update(BOUNDARY_HASH_DOMAIN, "utf8");
  let volatile = false;
  prompt.turns.forEach((turn, turnIndex) => {
    if (turn.blocks.length === 0) throw new Error("Prompt turns cannot be empty");
    updateFramed(hash, turn.role);
    turn.blocks.forEach((block, blockIndex) => {
      if (block.text.length === 0) throw new Error("Prompt blocks cannot be empty");
      if (block.stability === "volatile") volatile = true;
      else if (volatile) throw new Error("Stable prompt content cannot follow volatile content");
      updateFramed(hash, block.text);
      if (block.stability === "stable" && block.boundaryAfter === "candidate") {
        boundaries.push({
          hash: hash.copy().digest("hex"),
          location: { turn: turnIndex, block: blockIndex }
        });
      }
    });
  });
  return boundaries;
}

function exactPrefixTokenCount(
  prompt: PromptPlan,
  boundary: PromptBlockLocation,
  countTokens: PromptTokenCounter
): number | null {
  const contents: string[] = [];
  for (let turnIndex = 0; turnIndex <= boundary.turn; turnIndex += 1) {
    const turn = prompt.turns[turnIndex]!;
    const lastBlock = turnIndex === boundary.turn ? boundary.block : turn.blocks.length - 1;
    contents.push(turn.blocks.slice(0, lastBlock + 1).map((block) => block.text).join(""));
  }
  return countTokens(contents);
}

function updateFramed(hash: Hash, value: string): void {
  hash.update(String(Buffer.byteLength(value)), "ascii");
  hash.update(":", "ascii");
  hash.update(value, "utf8");
  hash.update("\0", "utf8");
}
