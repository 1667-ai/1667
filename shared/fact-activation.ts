import { assembleChapterContext, type ChapterPartLike } from "./chapters.js";
import { splitRegexKey } from "./fact-keys.js";
import {
  DEFAULT_FACT_SCAN_PARTS,
  MAX_FACT_PATTERN_STEPS,
  MAX_FACT_RECURSION_ROUNDS,
  type FactSecondaryMode
} from "./fact-metadata.js";
import { compileFactPattern, factPatternMatches, type FactPatternBudget } from "./fact-pattern.js";
import { effectiveFactFromState, resolveFactState } from "./fact-state.js";
import type { EffectiveStoryFact } from "./fact-state.js";
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
  readonly stateId?: string;
  readonly anchorPartId?: string;
}

export interface FactActivationResult {
  /** Facts after path resolution. Each entry carries only the effective
   * state text; the persisted state list stays on StoryFact. */
  readonly facts: readonly EffectiveStoryFact[];
  readonly traces: ReadonlyMap<string, FactActivationTrace>;
  readonly unevaluated: readonly string[];
  /** Fact ids whose effective state has no anchor on the request path. */
  readonly outOfScope: readonly string[];
  /** Fact ids whose deepest effective state is an End State. */
  readonly ended: readonly string[];
  /** Keyed Fact ids that had an in-scope state but no matching key. */
  readonly keyedMiss: readonly string[];
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
  const scoped = scopeFacts(facts, context === undefined
    ? undefined
    : context.requestPath ?? context.contextParts);
  return selectActiveFactsForSource(
    scoped.facts,
    context === undefined ? factScanSourceFromTexts([]) : factScanSource(context),
    scoped.outOfScope,
    scoped.ended
  );
}
function selectActiveFactsForSource(
  facts: readonly EffectiveStoryFact[],
  source: FactScanSource,
  outOfScope: readonly string[] = [],
  ended: readonly string[] = []
): FactActivationResult {
  const traces = new Map<string, FactActivationTrace>();
  const active = new Set<string>();
  const unevaluated = new Set<string>();
  const keyedMiss = new Set<string>();
  for (const fact of facts) {
    if (fact.activation !== "always") continue;
    active.add(fact.id);
    traces.set(fact.id, {
      kind: "always",
      round: 0,
      gate: null,
      ...traceState(fact)
    });
  }
  const budget: FactPatternBudget = { steps: MAX_FACT_PATTERN_STEPS, exhausted: false };
  const windows = new Map<number, FactScanSegment | null>();
  const window = (depth: number): FactScanSegment | null => {
    if (!windows.has(depth)) windows.set(depth, windowScanSegments(source, depth));
    return windows.get(depth)!;
  };
  let recursion: FactScanSegment | null = null;
  for (let round = 0; round <= MAX_FACT_RECURSION_ROUNDS; round += 1) {
    const fresh: EffectiveStoryFact[] = [];
    for (const fact of facts) {
      if (fact.activation !== "keyed" || active.has(fact.id)) continue;
      const scans = [
        window(fact.scanDepth ?? DEFAULT_FACT_SCAN_PARTS),
        ...(round === 0 ? [] : [recursion])
      ].filter((item): item is FactScanSegment => item !== null);
      const primary = matchAny(fact.keys, scans, budget);
      if (primary.state !== "matched") {
        if (primary.state === "unevaluated") unevaluated.add(fact.id);
        else keyedMiss.add(fact.id);
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
        if (gateMatched !== (mode === "and")) {
          keyedMiss.add(fact.id);
          continue;
        }
      }
      fresh.push(fact);
      active.add(fact.id);
      keyedMiss.delete(fact.id);
      unevaluated.delete(fact.id);
      traces.set(fact.id, {
        kind: primary.kind,
        key: primary.key,
        round,
        gate: secondary.length === 0 ? null : mode,
        ...traceState(fact)
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
  return {
    facts: facts.filter((fact) => active.has(fact.id)),
    traces,
    unevaluated: [...unevaluated],
    outOfScope: [...outOfScope],
    ended: [...ended],
    keyedMiss: [...keyedMiss]
  };
}

function traceState(fact: StoryFact | EffectiveStoryFact): Pick<FactActivationTrace, "stateId" | "anchorPartId"> {
  return "state" in fact
    ? { stateId: fact.state.id, ...(fact.state.anchorPartId === undefined ? {} : { anchorPartId: fact.state.anchorPartId }) }
    : {
        stateId: fact.states[0]?.id,
        ...(fact.states[0]?.anchorPartId === undefined ? {} : { anchorPartId: fact.states[0].anchorPartId })
      };
}

function scopeFacts(
  facts: readonly StoryFact[],
  requestPath: readonly { readonly id: string }[] | undefined
): { facts: readonly EffectiveStoryFact[]; outOfScope: readonly string[]; ended: readonly string[] } {
  const path = requestPath ?? [];
  const inScope: EffectiveStoryFact[] = [];
  const outOfScope: string[] = [];
  const ended: string[] = [];
  for (const fact of facts) {
    const resolution = resolveFactState(fact, path);
    if (resolution.kind === "active") {
      inScope.push(effectiveFactFromState(fact, resolution.state));
    } else if (resolution.kind === "ended") {
      ended.push(fact.id);
    } else {
      outOfScope.push(fact.id);
    }
  }
  return { facts: inScope, outOfScope, ended };
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
  const requestPath = path.slice(0, path.findIndex((part) => part.id === partId) + 1);
  const scoped = scopeFacts(facts, requestPath);
  return selectActiveFactsForSource(scoped.facts, factScanSourceFromTexts(
    assembled.map((part) => part.text ?? ""),
    instruction,
    selectedText
  ), scoped.outOfScope, scoped.ended);
}
