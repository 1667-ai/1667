import { assembleChapterContext, type ChapterPartLike } from "./chapters.js";
import { splitRegexKey } from "./fact-keys.js";
import {
  DEFAULT_FACT_SCAN_PARTS,
  FACT_ACTIVATIONS,
  FACT_PRIORITIES,
  FACT_RECURSIONS,
  FACT_SECONDARY_MODES,
  MAX_FACT_KEY_SCALARS,
  MAX_FACT_KEYS,
  MAX_FACT_PATTERN_STEPS,
  MAX_FACT_RECURSION_ROUNDS,
  MAX_FACT_SCAN_PARTS,
  MAX_FACT_SCAN_UTF16,
  FactActivationError,
  parseFactActivation,
  parseFactPriority,
  parseFactRecursion,
  parseFactScanDepth,
  parseFactSecondaryMode,
  type FactActivation,
  type FactPriority,
  type FactRecursion,
  type FactSecondaryMode
} from "./fact-metadata.js";
import { parseFactKeys } from "./fact-keys.js";
import { compileFactPattern, factPatternMatches, type FactPatternBudget } from "./fact-pattern.js";
import {
  literalFactKeyMatches,
  normalizeFactText,
  recursionScanSegment,
  scanSegments,
  windowScanSegments,
  type FactScanContext,
  type FactScanSegment
} from "./fact-scan.js";
import type { ChapterBreak, StoryFact, StoryNode } from "./types.js";

export {
  DEFAULT_FACT_SCAN_PARTS,
  FACT_ACTIVATIONS,
  FACT_PRIORITIES,
  FACT_RECURSIONS,
  FACT_SECONDARY_MODES,
  MAX_FACT_KEY_SCALARS,
  MAX_FACT_KEYS,
  MAX_FACT_PATTERN_STEPS,
  MAX_FACT_RECURSION_ROUNDS,
  MAX_FACT_SCAN_PARTS,
  MAX_FACT_SCAN_UTF16,
  FactActivationError,
  normalizeFactText,
  parseFactActivation,
  parseFactKeys,
  parseFactPriority,
  parseFactRecursion,
  parseFactScanDepth,
  parseFactSecondaryMode
};
export type { FactActivation, FactPriority, FactRecursion, FactSecondaryMode, FactScanContext };

export interface FactMetadata {
  activation: FactActivation;
  keys: string[];
  priority: FactPriority;
  secondaryKeys: string[];
  secondaryMode: FactSecondaryMode;
  scanDepth: number;
  recursion: FactRecursion;
}

export function parseFactMetadata(
  activationValue: unknown,
  keysValue: unknown,
  label = "Fact",
  priorityValue?: unknown,
  secondaryKeysValue?: unknown,
  secondaryModeValue?: unknown,
  scanDepthValue?: unknown,
  recursionValue?: unknown
): FactMetadata {
  return {
    activation: activationValue === undefined ? "always" : parseFactActivation(activationValue, `${label} activation`),
    keys: keysValue === undefined ? [] : parseFactKeys(keysValue, `${label} keys`),
    priority: priorityValue === undefined ? "normal" : parseFactPriority(priorityValue, `${label} priority`),
    secondaryKeys: secondaryKeysValue === undefined
      ? []
      : parseFactKeys(secondaryKeysValue, `${label} secondaryKeys`),
    secondaryMode: secondaryModeValue === undefined
      ? "and"
      : parseFactSecondaryMode(secondaryModeValue, `${label} secondaryMode`),
    scanDepth: scanDepthValue === undefined
      ? DEFAULT_FACT_SCAN_PARTS
      : parseFactScanDepth(scanDepthValue, `${label} scanDepth`),
    recursion: recursionValue === undefined ? "on" : parseFactRecursion(recursionValue, `${label} recursion`)
  };
}

export type FactMatchKind = "always" | "literal" | "regex";

export interface FactActivationTrace {
  readonly kind: FactMatchKind;
  readonly key?: string;
  readonly round: number;
  readonly gate: FactSecondaryMode | null;
}

export interface FactActivationResult {
  readonly facts: readonly StoryFact[];
  readonly traces: ReadonlyMap<string, FactActivationTrace>;
  readonly unevaluated: readonly string[];
}

const COMPILED_PATTERN_CACHE_LIMIT = 64;
const compiledPatterns = new Map<string, ReturnType<typeof compileFactPattern>>();
const ACTIVATION_CACHE_LIMIT = 2;
const activationCache: Array<{
  readonly facts: readonly StoryFact[];
  readonly factKey: string;
  readonly segmentKey: string;
  readonly result: FactActivationResult;
}> = [];

/** Compatibility selection. New callers use `selectActiveFactsWithTrace`. */
export function selectActiveFacts(
  facts: readonly StoryFact[],
  context?: FactScanContext
): StoryFact[] {
  return selectActiveFactsWithTrace(facts, context).facts.slice();
}
export function selectActiveFactsWithTrace(
  facts: readonly StoryFact[],
  context?: FactScanContext
): FactActivationResult {
  const parts = context === undefined ? [] : scanSegments(context);
  const segmentKey = JSON.stringify(parts);
  const factKey = JSON.stringify(facts.map((fact) => [
    fact.id,
    fact.text,
    fact.activation,
    fact.keys,
    fact.secondaryKeys,
    fact.secondaryMode,
    fact.scanDepth,
    fact.recursion
  ]));
  const cached = activationCache.find((entry) =>
    entry.facts === facts && entry.factKey === factKey && entry.segmentKey === segmentKey
  );
  if (cached !== undefined) return cached.result;
  const result = selectActiveFactsForSegments(facts, parts);
  if (activationCache.length === ACTIVATION_CACHE_LIMIT) activationCache.shift();
  activationCache.push({ facts, factKey, segmentKey, result });
  return result;
}
function selectActiveFactsForSegments(
  facts: readonly StoryFact[],
  parts: readonly string[]
): FactActivationResult {
  const traces = new Map<string, FactActivationTrace>();
  const active = new Set<string>();
  const unevaluated = new Set<string>();
  for (const fact of facts) {
    if (fact.activation !== "always") continue;
    active.add(fact.id);
    traces.set(fact.id, { kind: "always", round: 0, gate: null });
  }
  const budget: FactPatternBudget = { steps: MAX_FACT_PATTERN_STEPS, exhausted: false };
  const windows = new Map<number, FactScanSegment | null>();
  const window = (depth: number): FactScanSegment | null => {
    if (!windows.has(depth)) windows.set(depth, windowScanSegments(parts, depth));
    return windows.get(depth)!;
  };
  let recursion: FactScanSegment | null = null;
  for (let round = 0; round <= MAX_FACT_RECURSION_ROUNDS; round += 1) {
    const fresh: StoryFact[] = [];
    for (const fact of facts) {
      if (fact.activation !== "keyed" || active.has(fact.id)) continue;
      const scans = [
        window(fact.scanDepth ?? DEFAULT_FACT_SCAN_PARTS),
        ...(round === 0 ? [] : [recursion])
      ].filter((item): item is FactScanSegment => item !== null);
      const primary = matchAny(fact.keys, scans, budget);
      if (primary === false || primary === undefined) {
        if (primary === undefined) unevaluated.add(fact.id);
        continue;
      }
      const secondary = fact.secondaryKeys ?? [];
      const mode = fact.secondaryMode ?? "and";
      if (secondary.length > 0) {
        const gate = matchAny(secondary, scans, budget);
        if (gate === undefined) {
          unevaluated.add(fact.id);
          continue;
        }
        if ((mode === "and") !== (gate !== false)) continue;
      }
      fresh.push(fact);
      active.add(fact.id);
      traces.set(fact.id, {
        kind: primary.kind,
        key: primary.key,
        round,
        gate: secondary.length === 0 ? null : mode
      });
    }
    recursion = recursionScanSegment(
      facts
        .filter((fact) => active.has(fact.id) && fact.recursion !== "off")
        .map((fact) => fact.text)
    );
    // Always-active Facts seed recursion even when no keyed Fact matches the
    // external scan. A first empty round is therefore only terminal when no
    // recursive source exists.
    if (fresh.length === 0 && recursion === null) break;
    if (fresh.length === 0 && round > 0) break;
  }
  return { facts: facts.filter((fact) => active.has(fact.id)), traces, unevaluated: [...unevaluated] };
}
function matchAny(
  keys: readonly string[],
  scans: readonly FactScanSegment[],
  budget: FactPatternBudget
): { kind: "literal" | "regex"; key: string } | false | undefined {
  let skipped = false;
  for (const key of keys) {
    const pattern = splitRegexKey(key);
    if (pattern === null) {
      if (scans.some((scan) => literalFactKeyMatches(scan, key))) {
        return { kind: "literal", key };
      }
      continue;
    }
    if (budget.exhausted) {
      skipped = true;
      continue;
    }
    const compiled = compiledFactPattern(pattern.source, pattern.flags);
    if (scans.some((scan) => factPatternMatches(compiled, scan.text, budget, scan.before))) {
      return { kind: "regex", key };
    }
    if (budget.exhausted) {
      skipped = true;
      break;
    }
  }
  return skipped ? undefined : false;
}
function compiledFactPattern(source: string, flags: string): ReturnType<typeof compileFactPattern> {
  const key = `${source}/${flags}`;
  const cached = compiledPatterns.get(key);
  if (cached !== undefined) return cached;
  const compiled = compileFactPattern(source, flags);
  if (compiledPatterns.size >= COMPILED_PATTERN_CACHE_LIMIT) {
    compiledPatterns.delete(compiledPatterns.keys().next().value!);
  }
  compiledPatterns.set(key, compiled);
  return compiled;
}
export function assembleRewriteContext<Node extends ChapterPartLike>(
  path: readonly StoryNode[],
  partId: string,
  chapterBreaks: readonly ChapterBreak[],
  nodes: readonly Node[]
): Array<StoryNode | Node> {
  const target = path.findIndex((part) => part.id === partId);
  if (target < 0) throw new Error(`Unknown rewrite part: ${partId}`);
  return assembleChapterContext(
    path.slice(0, target + 1),
    chapterBreaks.filter((chapter) => chapter.parentPartId !== partId),
    nodes
  );
}

export function selectActiveFactsForRewriteWithTrace<Node extends ChapterPartLike>(
  facts: readonly StoryFact[],
  path: readonly StoryNode[],
  partId: string,
  chapterBreaks: readonly ChapterBreak[],
  nodes: readonly Node[],
  instruction: string,
  selectedText: string
): FactActivationResult {
  const assembled = assembleRewriteContext(path, partId, chapterBreaks, nodes);
  return selectActiveFactsForSegments(facts, [
    ...assembled.map((part) => part.text ?? ""),
    instruction,
    selectedText
  ]);
}

export function selectActiveFactsForRewrite<Node extends ChapterPartLike>(
  facts: readonly StoryFact[],
  path: readonly StoryNode[],
  partId: string,
  chapterBreaks: readonly ChapterBreak[],
  nodes: readonly Node[],
  instruction: string,
  selectedText: string
): StoryFact[] {
  return selectActiveFactsForRewriteWithTrace(
    facts,
    path,
    partId,
    chapterBreaks,
    nodes,
    instruction,
    selectedText
  ).facts.slice();
}
