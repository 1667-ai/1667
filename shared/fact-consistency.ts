import { deriveChapters, type ChapterPartLike } from "./chapters.js";
import { resolveFactStateAtPathPosition } from "./fact-state.js";
import {
  MAX_FACT_CONSISTENCY_FINDINGS_PER_PART,
  MAX_FACT_CONSISTENCY_PART_CHARS,
  MAX_FACT_CONSISTENCY_RUN_BYTES,
  MAX_FACT_CONSISTENCY_STATEMENT_CHARS,
  type FactConsistencyApplicableFact,
  type FactConsistencyFinding,
  type FactConsistencyPartSelection,
  type FactConsistencyScope
} from "./fact-consistency-types.js";
import {
  isChapterSummary,
  pathTo,
  descendantLine,
  type TreeNode
} from "./story-tree.js";
import type { Story, StoryNode } from "./types.js";

export interface FactConsistencySelectionStory<Node extends TreeNode & ChapterPartLike = StoryNode> {
  readonly nodes: Node[];
  readonly activeRootId: string | null;
  readonly facts: Story["facts"];
  readonly chapterBreaks: Story["chapterBreaks"];
  readonly firstChapterTitle?: string;
}

export interface FactConsistencySelectionInput<Node extends TreeNode & ChapterPartLike = StoryNode> {
  readonly story: FactConsistencySelectionStory<Node>;
  readonly focusedPartId: string;
  readonly scope: FactConsistencyScope;
}

/** The structural selection shared by backend admission and TUI preflight.
 * `line` is the exact path used for Fact State positions. `eligibleParts` is
 * the subset that has at least one active Fact State at its position. */
export interface FactConsistencyStructuralSelection<Node extends TreeNode & ChapterPartLike = StoryNode> {
  readonly line: readonly Node[];
  readonly parts: readonly Node[];
  readonly pathPositions: ReadonlyMap<string, number>;
  readonly eligibleParts: readonly Node[];
  readonly totalPartCount: number;
  readonly eligiblePartCount: number;
  readonly skippedPartCount: number;
}

/** Return the exact active line used by both scope selection and run
 * provenance. Summary nodes never enter a provider request or the persisted
 * selected-take list. */
export function factConsistencyLine<Node extends TreeNode & ChapterPartLike = StoryNode>(
  story: FactConsistencySelectionStory<Node>,
  focusedPartId: string
): readonly Node[] {
  const focus = story.nodes.find((node) => node.id === focusedPartId);
  if (focus === undefined || isChapterSummary(focus)) {
    throw new Error(`Unknown prose part: ${focusedPartId}`);
  }
  return dedupeNodes([
    ...pathTo(story, focusedPartId).filter((node) => !isChapterSummary(node)),
    ...descendantLine(story, focusedPartId).filter((node) => !isChapterSummary(node))
  ]);
}

/** Select scope and resolve eligibility once. Callers that need Fact State
 * text can reuse `pathPositions` rather than rebuilding a prefix map. */
export function selectFactConsistencyStructure<Node extends TreeNode & ChapterPartLike = StoryNode>(
  input: FactConsistencySelectionInput<Node>
): FactConsistencyStructuralSelection<Node> {
  const { story, focusedPartId, scope } = input;
  const line = factConsistencyLine(story, focusedPartId);
  const parts = scope === "chapter"
    ? chapterParts(story, line, focusedPartId)
    : line;
  const pathPositions = new Map(line.map((node, index) => [node.id, index] as const));
  const eligibleParts = parts.filter((node) => {
    const position = pathPositions.get(node.id);
    return position !== undefined && story.facts.some((fact) =>
      resolveFactStateAtPathPosition(fact, pathPositions, position).kind === "active"
    );
  });
  return {
    line,
    parts,
    pathPositions,
    eligibleParts,
    totalPartCount: parts.length,
    eligiblePartCount: eligibleParts.length,
    skippedPartCount: parts.length - eligibleParts.length
  };
}

/** Select the focused chapter or selected line and resolve Fact States once
 * for each selected take. The path index is shared, and its prefix boundary
 * keeps a future Anchor from affecting prose that appears before it. */
export function selectFactConsistencyParts(
  input: FactConsistencySelectionInput
): readonly FactConsistencyPartSelection[] {
  const { story } = input;
  const selection = selectFactConsistencyStructure(input);
  return selection.eligibleParts.flatMap((node) => {
    const position = selection.pathPositions.get(node.id);
    if (position === undefined) return [];
    const facts = story.facts.flatMap((fact): FactConsistencyApplicableFact[] => {
      const resolved = resolveFactStateAtPathPosition(fact, selection.pathPositions, position);
      if (resolved.kind !== "active") return [];
      return [{
        factId: fact.id,
        name: fact.name ?? null,
        tag: fact.tag ?? null,
        stateId: resolved.state.id,
        text: resolved.state.text
      }];
    });
    if (facts.length === 0) return [];
    return [{
      partId: node.id,
      takeId: node.id,
      text: node.text,
      facts
    }];
  });
}

function chapterParts<Node extends TreeNode & ChapterPartLike>(
  story: FactConsistencySelectionStory<Node>,
  line: readonly Node[],
  focusedPartId: string
): readonly Node[] {
  const chapters = deriveChapters(
    line,
    story.chapterBreaks,
    story.nodes,
    story.firstChapterTitle ?? ""
  );
  const chapter = chapters.find((candidate) =>
    candidate.parts.some((part) => part.id === focusedPartId)
  );
  return chapter?.parts ?? [];
}

function dedupeNodes<Node extends TreeNode>(nodes: readonly Node[]): Node[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

export interface FactConsistencyParseResult {
  readonly findings: readonly FactConsistencyFinding[];
  /** Candidates rejected by the verification rules or the per-part bound. */
  readonly droppedFindings: number;
  /** True when the provider did not return a parseable response body. */
  readonly malformed: boolean;
  /** The request-specific completion marker was present and well-formed. */
  readonly complete: boolean;
}

export interface FactConsistencyParseOptions {
  /** Maximum accepted findings for this part or batch. */
  readonly maxFindings?: number;
  /** Maximum UTF-8 bytes occupied by accepted finding values. */
  readonly maxBytes?: number;
}

/** Parse the provider's plain-text finding blocks and reject findings that
 * cannot point to the selected prose and one of its applicable Fact States. */
export function parseFactConsistencyFindings(
  raw: string,
  partText: string,
  facts: readonly FactConsistencyApplicableFact[],
  marker?: string,
  options: FactConsistencyParseOptions = {}
): FactConsistencyParseResult {
  if (partText.length > MAX_FACT_CONSISTENCY_PART_CHARS) {
    throw new Error("Fact consistency part text exceeds its size limit");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_FACT_CONSISTENCY_RUN_BYTES) {
    return { findings: [], droppedFindings: 0, malformed: true, complete: false };
  }
  const expectedMarker = marker ?? null;
  const maxFindings = options.maxFindings ?? MAX_FACT_CONSISTENCY_FINDINGS_PER_PART;
  const maxBytes = options.maxBytes ?? MAX_FACT_CONSISTENCY_RUN_BYTES;
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 0
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Fact consistency parse limits are invalid");
  }
  let body = raw;
  if (expectedMarker !== null) {
    const markerAt = raw.lastIndexOf(expectedMarker);
    if (markerAt < 0 || raw.slice(markerAt + expectedMarker.length).trim().length > 200) {
      return { findings: [], droppedFindings: 0, malformed: false, complete: false };
    }
    body = raw.slice(0, markerAt);
  }

  if (isNoneResponse(body)) {
    return { findings: [], droppedFindings: 0, malformed: false, complete: true };
  }

  const findings: FactConsistencyFinding[] = [];
  let findingBytes = 0;
  let droppedFindings = 0;
  let blockCount = 0;
  visitFindingBlocks(body, (block) => {
    blockCount += 1;
    if (findings.length >= maxFindings) {
      droppedFindings += 1;
      return;
    }
    const number = parseFactNumber(block.fact);
    const fact = number === null ? undefined : facts[number - 1];
    const quote = normalizeQuote(block.quote);
    const statement = normalizeStatement(block.statement);
    if (
      fact === undefined
      || quote.length === 0
      || quote === partText.trim()
      || !partText.includes(quote)
      || statement.length === 0
      || statement.length > MAX_FACT_CONSISTENCY_STATEMENT_CHARS
    ) {
      droppedFindings += 1;
      return;
    }
    const finding = { fact_id: fact.factId, quote, statement };
    const bytes = Buffer.byteLength(JSON.stringify(finding), "utf8")
      + (findings.length === 0 ? 0 : 1);
    if (findingBytes + bytes > maxBytes) {
      droppedFindings += 1;
      return;
    }
    findings.push(finding);
    findingBytes += bytes;
  });
  if (blockCount === 0) {
    return {
      findings: [],
      droppedFindings: body.trim().length === 0 ? 0 : 1,
      malformed: body.trim().length > 0,
      complete: true
    };
  }
  return { findings, droppedFindings, malformed: false, complete: true };
}

interface FindingBlock {
  readonly fact: string;
  readonly quote: string;
  readonly statement: string;
}

const FACT_CONSISTENCY_LABEL_PATTERN = /^\s*(?:[-*]\s*)?(?:[*_`#]+\s*)?(FACT|QUOTE|STATEMENT)(?:(?:[*_`#]+)?\s*:\s*(?:[*_`#]+\s*)?|(?:[*_`#]+)?\s+-\s+|(?:[*_`#]+)?\s+)(.*)$/iu;

function visitFindingBlocks(raw: string, visit: (block: FindingBlock) => void): void {
  let current: Partial<Record<"fact" | "quote" | "statement", string>> | null = null;
  let currentLabel: "fact" | "quote" | "statement" | null = null;
  const push = () => {
    if (current !== null) {
      visit({
        fact: current.fact ?? "",
        quote: current.quote ?? "",
        statement: current.statement ?? ""
      });
    }
    current = null;
    currentLabel = null;
  };
  for (const line of raw.split(/\r?\n/u)) {
    const label = factConsistencyLabel(line);
    if (label !== null) {
      if (label === "fact" && current !== null && current.fact !== undefined) push();
      current ??= {};
      currentLabel = label;
      current[label] = labelValue(line);
      continue;
    }
    if (current === null || currentLabel === null || line.trim().length === 0) continue;
    current[currentLabel] = `${current[currentLabel] ?? ""}\n${line}`.trim();
  }
  push();
}

function factConsistencyLabel(
  line: string
): "fact" | "quote" | "statement" | null {
  const match = FACT_CONSISTENCY_LABEL_PATTERN.exec(line);
  if (match === null) return null;
  return match[1]!.toLowerCase() as "fact" | "quote" | "statement";
}

function labelValue(line: string): string {
  const match = FACT_CONSISTENCY_LABEL_PATTERN.exec(line);
  return match?.[2] ?? "";
}

function parseFactNumber(value: string): number | null {
  const match = /^\s*(\d+)\s*$/u.exec(value);
  if (match === null) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeQuote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function normalizeStatement(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isNoneResponse(raw: string): boolean {
  return raw.trim().replace(/[\s*_`#.!-]/gu, "").toUpperCase() === "NONE";
}
