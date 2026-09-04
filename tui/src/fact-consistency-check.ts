import type { NodeStub, StoryPayload } from "../../shared/types.js";
import {
  type FactConsistencyRun as BackendFactConsistencyRun,
  type FactConsistencyScope as BackendFactConsistencyScope
} from "../../shared/fact-consistency-types.js";
import {
  factConsistencyLine as sharedFactConsistencyLine,
  selectFactConsistencyStructure,
  type FactConsistencySelectionInput
} from "../../shared/fact-consistency.js";
import { pathTo } from "../../shared/story-tree.js";
import { rowPart, type StoryViewModel } from "./model.js";
import { factName } from "./facts-model.js";

/** The two contextual Fact consistency entry points. */
export type FactConsistencyScope = "chapter" | "line";

export interface FactConsistencyCheckedPart {
  readonly partId: string;
  readonly takeId: string;
}

export interface FactConsistencyUncheckedPart {
  readonly partId: string;
  readonly takeId: string;
  readonly lineIndex: number;
  readonly reason: string;
}

/** The backend run shape consumed by the completed-run surface. */
export interface FactConsistencyRun {
  readonly scope: FactConsistencyScope;
  readonly checkedParts: readonly FactConsistencyCheckedPart[];
  readonly uncheckedParts: readonly FactConsistencyUncheckedPart[];
  readonly findings: readonly FactConsistencyFinding[];
  readonly rejectedCount: number;
}

export interface FactConsistencyFinding {
  readonly factId: string;
  readonly factName: string;
  readonly partId: string;
  readonly takeId: string;
  readonly lineIndex: number;
  readonly quote: string;
  readonly statement: string;
  /** Set only for a fresh run started from an intentionally off-line take.
   * Persisted runs omit this transient provenance and treat later switches as
   * stale, so a writer cannot reactivate an old selection after reopening. */
  readonly offLineAtRun?: true;
}

/** The preflight projection shown before a provider request starts. */
export interface FactConsistencyPreflight {
  readonly scope: FactConsistencyScope;
  readonly totalPartCount: number;
  readonly eligiblePartCount: number;
  readonly skippedPartCount: number;
  readonly checkedParts: readonly FactConsistencyCheckedPart[];
  /** Local preflight uses eligible parts as a provisional count. Persisted
   * runs omit this field because they do not record backend batching. */
  readonly requestCount?: number;
  /** True only after the backend plan has supplied the exact batch count. */
  readonly requestCountExact?: boolean;
}

/** Return the selected take's branch. The normal Story view only contains the
 * active line, while MAP/PROBS/RECORD can point at any prose take. */
export function factConsistencyLineForPart(
  payload: StoryPayload,
  focusedPartId: string
): readonly NodeStub[] {
  return sharedFactConsistencyLine(
    factConsistencyStory(payload),
    focusedPartId
  );
}

function factConsistencyStory(payload: StoryPayload): FactConsistencySelectionInput<NodeStub>["story"] {
  return {
    nodes: payload.nodes,
    activeRootId: payload.activeRootId,
    facts: payload.facts,
    chapterBreaks: payload.chapterBreaks,
    firstChapterTitle: payload.firstChapterTitle
  };
}

function selectionForPart(
  payload: StoryPayload,
  focusedPartId: string,
  scope: FactConsistencyScope
) {
  return selectFactConsistencyStructure({
    story: factConsistencyStory(payload),
    focusedPartId,
    scope: scope === "line" ? "story-line" : "chapter"
  });
}

/** Select the chapter or story line that the backend will inspect. This uses
 * only structural stubs and Fact anchor ids, so an off-active take needs no
 * fabricated prose or provider metadata in the local view. */
export function factConsistencySelectionForPart(
  payload: StoryPayload,
  focusedPartId: string,
  scope: FactConsistencyScope
): readonly NodeStub[] {
  return selectionForPart(payload, focusedPartId, scope).parts;
}

/** Build the preflight for a MAP/PROBS/RECORD selection without asking the
 * active-path Story view to represent an off-active take. */
export function factConsistencyPreflightForPart(
  payload: StoryPayload,
  focusedPartId: string,
  scope: FactConsistencyScope
): FactConsistencyPreflight {
  const selection = selectionForPart(payload, focusedPartId, scope);
  const checkedParts = selection.eligibleParts.map(({ id }) => ({ partId: id, takeId: id }));
  return {
    scope,
    totalPartCount: selection.totalPartCount,
    eligiblePartCount: checkedParts.length,
    skippedPartCount: selection.skippedPartCount,
    checkedParts,
    requestCount: checkedParts.length,
    requestCountExact: false
  };
}

/** Project the persisted backend run into the compact TUI view. The backend
 * keeps provider fields and per-part storage details; the list needs only
 * checked take identities, display names, findings, and the rejection count. */
export function factConsistencyRunView(
  run: BackendFactConsistencyRun,
  payload: StoryPayload,
  options: { readonly selectedTakeIds?: ReadonlySet<string> } = {}
): FactConsistencyRun {
  const pathIds = payload.path.map(({ id }) => id);
  const selectedTakeIds = options.selectedTakeIds;
  const findings = run.parts.flatMap((part) => {
    const lineIndex = run.storyLineTakeIds.indexOf(part.takeId);
    // New runs persist the selection provenance. Only legacy runs without
    // that field may infer it from the response payload path: a newer path
    // can arrive while the provider request is still in flight.
    const offLineAtRun = part.selectedAtRun === undefined
      ? selectedTakeIds !== undefined && !selectedTakeIds.has(part.takeId)
      : part.selectedAtRun === false;
    return part.findings.map((finding) => ({
      factId: finding.fact_id,
      factName: factNameForFinding(payload, finding.fact_id, part.partId, part.takeId, pathIds),
      partId: part.partId,
      takeId: part.takeId,
      lineIndex,
      quote: finding.quote,
      statement: finding.statement,
      ...(offLineAtRun
        ? { offLineAtRun: true as const }
        : {})
    }));
  });
  return {
    scope: backendScope(run.scope),
    checkedParts: run.parts.flatMap((part) => part.uncheckedReason === undefined
      ? [{ partId: part.partId, takeId: part.takeId }]
      : []),
    uncheckedParts: run.parts.flatMap((part) => part.uncheckedReason === undefined
      ? []
      : [{
          partId: part.partId,
          takeId: part.takeId,
          lineIndex: run.storyLineTakeIds.indexOf(part.takeId),
          reason: part.uncheckedReason
        }]),
    findings,
    rejectedCount: run.droppedFindings
  };
}

/** Rebuild the completed-run shell from persisted coverage. The anchor can
 * disappear after a run when its take is deleted or pruned, but the run still
 * has enough metadata to render its results and stale finding markers. */
export function factConsistencyPreflightFromRun(
  run: BackendFactConsistencyRun
): FactConsistencyPreflight {
  const checkedParts = run.parts.flatMap((part) => part.uncheckedReason === undefined
    ? [{ partId: part.partId, takeId: part.takeId }]
    : []);
  return {
    scope: backendScope(run.scope),
    totalPartCount: run.parts.length,
    eligiblePartCount: checkedParts.length,
    // Persisted runs do not record parts skipped before provider work. Keep
    // this count honest instead of treating unchecked provider work as a
    // missing Fact State.
    skippedPartCount: 0,
    checkedParts
  };
}

/** Resolve the same path-scoped states that the Facts panel uses. Parts with
 * no active state are omitted from `checkedParts` and are never requested. */
export function factConsistencyPreflight(
  payload: StoryPayload,
  view: StoryViewModel,
  scope: FactConsistencyScope,
  focusIndex: number
): FactConsistencyPreflight {
  const focusedPart = rowPart(view, focusIndex);
  if (focusedPart === null) {
    return {
      scope,
      totalPartCount: 0,
      eligiblePartCount: 0,
      skippedPartCount: 0,
      checkedParts: [],
      requestCount: 0,
      requestCountExact: false
    };
  }
  const selection = selectionForPart(payload, focusedPart.id, scope);
  const checkedParts = selection.eligibleParts.map(({ id }) => ({ partId: id, takeId: id }));
  return {
    scope,
    totalPartCount: selection.totalPartCount,
    eligiblePartCount: checkedParts.length,
    skippedPartCount: selection.skippedPartCount,
    checkedParts,
    requestCount: checkedParts.length,
    requestCountExact: false
  };
}

export function emptyFactConsistencyRun(
  preflight: FactConsistencyPreflight
): FactConsistencyRun {
  return {
    scope: preflight.scope,
    checkedParts: preflight.checkedParts,
    uncheckedParts: [],
    findings: [],
    rejectedCount: 0
  };
}

export type FactConsistencyFindingStatus = "current" | "off-line" | "stale";

/** Keep an available, unselected take distinct from a deleted or edited take.
 * Payload stubs may omit off-line text, so absence of text is not evidence of
 * a rewrite; a loaded text value must fail the quote check explicitly. */
export function factConsistencyFindingStatus(
  payload: StoryPayload,
  finding: Pick<FactConsistencyFinding, "partId" | "takeId" | "quote" | "offLineAtRun">
): FactConsistencyFindingStatus {
  const take = payload.nodes.find(({ id }) => id === finding.takeId);
  if (take === undefined || take.role === "summary") return "stale";
  const selectedTake = payload.path.find(({ id }) => id === finding.takeId);
  const text = selectedTake?.text ?? take.text;
  if (text !== undefined && !text.includes(finding.quote)) return "stale";
  if (selectedTake !== undefined) return "current";
  return finding.offLineAtRun === true ? "off-line" : "stale";
}

/** A finding stays visible after a take switch, but the list marks it stale. */
export function factConsistencyFindingIsStale(
  payload: StoryPayload,
  finding: Pick<FactConsistencyFinding, "partId" | "takeId" | "quote" | "offLineAtRun">
): boolean {
  return factConsistencyFindingStatus(payload, finding) !== "current";
}

export function factConsistencyScopeLabel(scope: FactConsistencyScope): string {
  return scope === "chapter" ? "chapter" : "story line";
}

function backendScope(scope: BackendFactConsistencyScope): FactConsistencyScope {
  return scope === "story-line" ? "line" : "chapter";
}

function factNameForFinding(
  payload: StoryPayload,
  factId: string,
  partId: string,
  takeId: string,
  pathIds: readonly string[]
): string {
  const fact = payload.facts.find(({ id }) => id === factId);
  if (fact === undefined) return "Unknown Fact";
  // A run records both its logical part and its selected take. They normally
  // match, but using the take when it is available keeps an unnamed Fact's
  // display name scoped to an off-active branch instead of the active path.
  const available = (id: string): boolean => payload.nodes.some(({ id: nodeId, role }) =>
    nodeId === id && role !== "summary"
  );
  const requestPathId = available(takeId) ? takeId
    : available(partId) ? partId : null;
  if (requestPathId === null) return factName(fact, pathIds);
  const pathIndex = pathIds.indexOf(requestPathId);
  const requestPath = pathIndex < 0
    ? pathTo({ nodes: payload.nodes, activeRootId: payload.activeRootId }, requestPathId)
      .map(({ id }) => id)
    : pathIds.slice(0, pathIndex + 1);
  return factName(fact, requestPath);
}
