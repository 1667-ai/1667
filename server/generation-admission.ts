import type { GenerationSettings } from "../shared/types.js";
import { ServiceError } from "./errors.js";

export const MAX_GENERATION_MODEL_ATTRIBUTIONS = 50;

/** Conservative token bound for fixed prompt text. */
function upperBoundTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide * 2;
}

/** Reject fixed context that cannot fit the selected model window. */
export function assertFixedContextFits(
  settings: GenerationSettings,
  facts: string | null,
  authorsNote: string | null,
  otherFixed: readonly string[]
): void {
  const notePresent = authorsNote !== null && authorsNote.trim().length > 0;
  if (settings.contextWindow === null || (facts === null && !notePresent)) return;
  const fixedTexts = [
    ...(facts === null ? [] : [facts]),
    ...(notePresent ? [authorsNote!] : []),
    ...otherFixed
  ];
  const framing = (fixedTexts.length + 2) * 4;
  const fixed = fixedTexts.reduce((sum, text) => sum + upperBoundTokens(text), framing);
  const usable = settings.contextWindow - settings.maxTokens;
  if (fixed <= usable) return;
  const factsTokens = facts === null ? 0 : upperBoundTokens(facts);
  const noteTokens = notePresent ? upperBoundTokens(authorsNote!) : 0;
  if (noteTokens > factsTokens) {
    throw new ServiceError(
      400,
      `The Author's Note is too large for the model's context window ` +
      `(~${fixed.toLocaleString()} fixed prompt tokens, ~${Math.max(0, usable).toLocaleString()} usable). ` +
      `Shorten the Author's Note, or raise the context window in Settings.`
    );
  }
  throw new ServiceError(
    400,
    `The story facts are too large for the model's context window ` +
    `(~${fixed.toLocaleString()} fixed prompt tokens, ~${Math.max(0, usable).toLocaleString()} usable). ` +
    `Shorten or consolidate facts, or raise the context window in Settings.`
  );
}

interface GenerationModelAttribution {
  readonly storyId: string;
  readonly genId: string;
  model: string;
}

/**
 * Process-local admission for continuation IDs. StoryService owns one instance,
 * so HTTP and worker callers contend on the same unambiguous story/gen tuple.
 */
export class GenerationAdmissionRegistry {
  private readonly active = new Map<string, Set<string>>();
  private readonly modelAttributions: GenerationModelAttribution[] = [];

  async run<T>(
    storyId: string,
    genId: string,
    operation: () => T | PromiseLike<T>
  ): Promise<T> {
    let storyGenerations = this.active.get(storyId);
    if (storyGenerations?.has(genId) === true) {
      throw new ServiceError(
        409,
        "This generation is already in progress; retry after it settles.",
        "resource_busy"
      );
    }
    if (storyGenerations === undefined) {
      storyGenerations = new Set();
      this.active.set(storyId, storyGenerations);
    }
    // No await between checking and claiming: one event-loop turn owns the tuple.
    storyGenerations.add(genId);
    try {
      return await operation();
    } finally {
      storyGenerations.delete(genId);
      if (storyGenerations.size === 0 && this.active.get(storyId) === storyGenerations) {
        this.active.delete(storyId);
      }
    }
  }

  rememberModel(storyId: string, genId: string, model: string): void {
    const existing = this.modelAttributions.find(
      (candidate) => candidate.storyId === storyId && candidate.genId === genId
    );
    if (existing !== undefined) {
      existing.model = model;
      return;
    }
    if (this.modelAttributions.length >= MAX_GENERATION_MODEL_ATTRIBUTIONS) {
      this.modelAttributions.shift();
    }
    this.modelAttributions.push({ storyId, genId, model });
  }

  modelFor(storyId: string, genId: string): string | undefined {
    return this.modelAttributions.find(
      (candidate) => candidate.storyId === storyId && candidate.genId === genId
    )?.model;
  }

  clear(): void {
    this.active.clear();
    this.modelAttributions.length = 0;
  }
}
