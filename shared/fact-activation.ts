import { assembleChapterContext, type ChapterPartLike } from "./chapters.js";
import { splitRegexKey } from "./fact-keys.js";
import {
  DEFAULT_FACT_SCAN_PARTS,
  MAX_FACT_PATTERN_STEPS,
  MAX_FACT_RECURSION_ROUNDS,
  type FactSecondaryMode
} from "./fact-metadata.js";
import { compileFactPattern, factPatternMatches, type FactPatternBudget } from "./fact-pattern.js";
import {
  literalFactKeyMatches,
  recursionScanSegment,
  factScanSource,
  factScanSourceFromTexts,
  windowScanSegments,
  type FactScanContext,
  type FactScanSource,
  type FactScanSegment
} from "./fact-scan.js";
import type { ChapterBreak, StoryFact, StoryNode } from "./types.js";

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

type FactKeyMatch =
  | { readonly state: "matched"; readonly kind: "literal" | "regex"; readonly key: string }
  | { readonly state: "not-matched" }
  | { readonly state: "unevaluated" };

const COMPILED_PATTERN_CACHE_LIMIT = 64;
const compiledPatterns = new Map<string, ReturnType<typeof compileFactPattern>>();
export function selectActiveFactsWithTrace(
  facts: readonly StoryFact[],
  context?: FactScanContext
): FactActivationResult {
  return selectActiveFactsForSource(
    facts,
    context === undefined ? factScanSourceFromTexts([]) : factScanSource(context)
  );
}
function selectActiveFactsForSource(
  facts: readonly StoryFact[],
  source: FactScanSource
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
    if (!windows.has(depth)) windows.set(depth, windowScanSegments(source, depth));
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
      if (primary.state !== "matched") {
        if (primary.state === "unevaluated") unevaluated.add(fact.id);
        continue;
      }
      const secondary = fact.secondaryKeys ?? [];
      const mode = fact.secondaryMode ?? "and";
      if (secondary.length > 0) {
        const gate = matchAny(secondary, scans, budget);
        if (gate.state === "unevaluated") {
          unevaluated.add(fact.id);
          continue;
        }
        const gateMatched = gate.state === "matched";
        if (gateMatched !== (mode === "and")) continue;
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
): FactKeyMatch {
  let skipped = false;
  for (const key of keys) {
    const pattern = splitRegexKey(key);
    if (pattern === null) {
      if (scans.some((scan) => literalFactKeyMatches(scan, key))) {
        return { state: "matched", kind: "literal", key };
      }
      continue;
    }
    if (budget.exhausted) {
      skipped = true;
      continue;
    }
    const compiled = compiledFactPattern(pattern.source, pattern.flags);
    if (scans.some((scan) => factPatternMatches(compiled, scan.text, budget, scan.before))) {
      return { state: "matched", kind: "regex", key };
    }
    if (budget.exhausted) {
      skipped = true;
      break;
    }
  }
  return skipped ? { state: "unevaluated" } : { state: "not-matched" };
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
  return selectActiveFactsForSource(facts, factScanSourceFromTexts(
    assembled.map((part) => part.text ?? ""),
    instruction,
    selectedText
  ));
}
