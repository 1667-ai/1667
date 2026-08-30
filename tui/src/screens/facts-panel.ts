import type { StoryPayload } from "../../../shared/types.js";
import {
  boundedFactSelection,
  FACT_SCOPE_FILTERS,
  factBody,
  factDossierEntries,
  factName,
  factOffPathNote,
  factPathProjection,
  factPriorityGlyph,
  factRows,
  factSearchHitContext,
  factStateDiff,
  factScopeLabel,
  factStatusDisplay,
  factStatusForPath,
  factTags,
  type FactPathProjection,
  type FactScopeFilter
} from "../facts-model.js";
import { isFactEndState } from "../../../shared/fact-state.js";
import { lineName } from "../../../shared/story-model.js";
import type { HitRegion, HitRows, HitTarget } from "../hit.js";
import type { KeyAction } from "../keys.js";
import type { RequestTokenEstimate } from "../request-projection.js";
import type { OverlayState } from "../state.js";
import {
  boundedContent,
  cellPad,
  factColumns,
  panelRange,
  panelRowWindow
} from "./panel-table-layout.js";
import {
  panelContentRows,
  panelHorizontalGeometry,
  placePanel,
  raisedSegment
} from "./overlay.js";
import {
  segment,
  truncate,
  truncateTail,
  visibleWidth,
  TYPING_CARET,
  type FrameComposition,
  type FrameLine
} from "./story/frame.js";

export const FACTS_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
  { token: "tab", action: "cycle" }, { token: "↵ open", action: "open-selected" },
  { token: "/ filter", action: "filter" }, { token: "e edit", action: "edit" },
  { token: "n new", action: "new-item" }, { token: "s state", action: "new-state" },
  { token: "x delete", action: "delete-item" },
  { token: "esc", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const FACTS_CONFIRM_FOOTER_ACTIONS = FACTS_FOOTER_ACTIONS.map((entry) =>
  entry.action === "delete-item" ? { ...entry, token: "x confirms" } : entry
) as ReadonlyArray<{ token: string; action: KeyAction }>;

const FACTS_COMPACT_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
  { token: "tab", action: "cycle" }, { token: "↵", action: "open-selected" },
  { token: "/", action: "filter" }, { token: "e", action: "edit" },
  { token: "n", action: "new-item" }, { token: "s state", action: "new-state" },
  { token: "x", action: "delete-item" }, { token: "esc", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const FACTS_COMPACT_CONFIRM_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
  { token: "tab", action: "cycle" }, { token: "↵", action: "open-selected" },
  { token: "/", action: "filter" }, { token: "e", action: "edit" },
  { token: "n", action: "new-item" }, { token: "s state", action: "new-state" },
  { token: "x confirms", action: "delete-item" }, { token: "esc keeps", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const FILTER_FOOTER_ACTIONS = [
  { token: "↵", action: "open-selected" },
  { token: "esc", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const DOSSIER_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" },
  { token: "↓", action: "focus-next" },
  { token: "↵ open", action: "open-selected" },
  { token: "[", action: "cycle-state", index: -1 },
  { token: "]", action: "cycle-state", index: 1 },
  { token: "n new state", action: "new-state" },
  { token: "x end", action: "end-state" },
  { token: "d diff", action: "toggle-fact-diff" },
  { token: "esc back", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction; index?: number }>;

const DOSSIER_COMPACT_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" },
  { token: "↓", action: "focus-next" },
  { token: "↵", action: "open-selected" },
  { token: "[", action: "cycle-state", index: -1 },
  { token: "]", action: "cycle-state", index: 1 },
  { token: "n", action: "new-state" },
  { token: "x", action: "end-state" },
  { token: "d", action: "toggle-fact-diff" },
  { token: "esc", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction; index?: number }>;

export function renderFactsPanel(
  base: FrameLine[],
  state: OverlayState & { payload: StoryPayload; hitRows: HitRows },
  width: number,
  height: number,
  estimate: RequestTokenEstimate
): FrameComposition {
  const overlay = state.facts!;
  const dossierFact = overlay.dossier === null || overlay.dossier === undefined
    ? null
    : state.payload.facts.find(({ id }) => id === overlay.dossier?.factId) ?? null;
  if (dossierFact !== null) {
    return renderFactsDossier(base, state, width, height, dossierFact);
  }
  const tags = factTags(state.payload.facts);
  const pathIds = state.payload.path.map(({ id }) => id);
  const factPaths = new Map<string, FactPathProjection>(
    state.payload.facts.map((fact) => [fact.id, factPathProjection(fact, pathIds)])
  );
  const scopeFilter = overlay.scopeFilter ?? "everywhere";
  const selection = boundedFactSelection(
    state.payload.facts, overlay, overlay.query, pathIds, scopeFilter
  );
  const rows = factRows(
    state.payload.facts, selection.selectedTag, overlay.query, pathIds, scopeFilter
  );
  const scopeNodes = [...state.payload.path, ...state.payload.nodes];
  const keyedFacts = state.payload.facts.filter(({ activation }) => activation === "keyed");
  const activeKeyedCount = keyedFacts.filter(
    (fact) => factStatusForPath(
      fact,
      estimate.factStatuses.get(fact.id) ?? { kind: "not-matched" },
      pathIds,
      factPaths.get(fact.id)!
    ).kind === "sent"
  ).length;
  const unevaluatedCount = estimate.activation.unevaluated.length;
  const contentWidth = panelHorizontalGeometry(width).contentWidth;
  const columns = factColumns(contentWidth);
  const tagChips = renderChipGroup(
    tags.map((tag) => tag ?? "all"),
    selection.chip,
    contentWidth,
    "tag"
  );
  const scopeChips = renderChipGroup(
    FACT_SCOPE_FILTERS.map(scopeLabel),
    FACT_SCOPE_FILTERS.indexOf(scopeFilter),
    contentWidth,
    "scope"
  );
  const chipLines: FrameLine[] = [];
  const chipOverridesByLine: HitRegion[][] = [];
  for (const [label, group] of [["tags", tagChips], ["scope", scopeChips]] as const) {
    group.lines.forEach((line, index) => {
      chipLines.push([
        raisedSegment(index === 0 ? `  ${label.padEnd(6, " ")}` : "        ", "chrome"),
        ...line
      ]);
      chipOverridesByLine.push(
        group.overrides[index]!.map((region) => ({
          ...region,
          left: region.left + 8,
          right: region.right + 8
        }))
      );
    });
  }

  const content: FrameLine[] = [...chipLines];
  if (overlay.filtering || overlay.query.length > 0) {
    content.push(filterLine(overlay.query, contentWidth,
      `${rows.length} of ${state.payload.facts.length}`));
  }
  const searchContext = overlay.selectedStateId === undefined || overlay.selectedStateId === null
    ? null
    : state.payload.facts
      .map((fact) => factSearchHitContext(
        fact, overlay.selectedStateId!, state.payload, factPaths.get(fact.id)!
      ))
      .find((context): context is string => context !== null) ?? null;
  if (searchContext !== null) {
    content.push([raisedSegment(`  ${searchContext}`, "context facts")]);
  }
  content.push([
    raisedSegment(cellPad("", columns.lead), "chrome"),
    raisedSegment(cellPad("name", columns.name), "chrome"),
    raisedSegment(cellPad("tag", columns.tag), "chrome"),
    raisedSegment(cellPad("scope", columns.scope), "chrome"),
    raisedSegment(cellPad("note", columns.note), "chrome"),
    raisedSegment(cellPad(`status${unevaluatedCount === 0 ? "" : ` ⚠${unevaluatedCount}`}`, columns.status), "chrome")
  ]);
  const targets: Array<HitTarget | null> = content.map(() => null);
  const window = panelRowWindow(
    rows.map(() => 1),
    selection.cursor,
    panelContentRows(height) - content.length
  );
  for (let index = window.start; index < window.end; index += 1) {
    const fact = rows[index]!;
    const path = factPaths.get(fact.id)!;
    const scopeKind = path.scope;
    const body = scopeKind === "elsewhere"
      ? factOffPathNote(fact, state.payload, path)
      : scopeKind === "ended"
        ? "ended here · no text rides"
        : factBody(fact, pathIds, path);
    const selected = index === selection.cursor;
    const requestStatus = factStatusForPath(
      fact,
      estimate.factStatuses.get(fact.id) ?? { kind: "not-matched" as const },
      pathIds,
      path
    );
    const display = factStatusDisplay(fact.activation, requestStatus, estimate.activation.traces.get(fact.id));
    const statusBase = display.glyph.length === 0 ? display.word : `${display.glyph} ${display.word}`;
    const priorityChar = factPriorityGlyph(fact.priority);
    // A blank glyph for "normal" priority keeps the column at its established
    // width for the common case; low/high only cost one more cell.
    const status = priorityChar.length === 0 ? statusBase : `${statusBase} ${priorityChar}`;
    content.push([
      raisedSegment(cellPad(selected ? "  ▸ " : "", columns.lead),
        selected ? "focus / accent" : "chrome"),
      raisedSegment(cellPad(truncate(factName(fact, pathIds, path), Math.max(0, columns.name - 1)), columns.name),
        selected ? "prose" : "prose · dim"),
      raisedSegment(cellPad(truncate(fact.tag ?? "—", Math.max(0, columns.tag - 1)), columns.tag),
        "accent · deep"),
      raisedSegment(cellPad(truncate(factScopeLabel(fact, pathIds, scopeNodes, path), Math.max(0, columns.scope - 1)), columns.scope),
        requestStatus.kind === "off-path" || requestStatus.kind === "ended" ? "prose · dim" : "chrome"),
      raisedSegment(cellPad(body.length > 0 ? body : "—", columns.note),
        scopeKind === "elsewhere" || scopeKind === "ended" ? "prose · dim" : "chrome"),
      raisedSegment(cellPad(status, columns.status), display.emphasis)
    ]);
    targets.push({ kind: "list", index });
  }
  if (rows.length === 0) {
    // C-27: an empty state names the key that fixes it. An unfiltered store
    // with nothing in it is a different sentence from a filter that matched
    // nothing, and `no matching facts` used to be printed for both.
    content.push([raisedSegment(
      `  ${factsEmptyState(overlay.query, overlay.filtering, state.payload.facts.length)}`,
      "prose · dim")]);
    targets.push(null);
  }

  const footer = overlay.filtering
    ? "↵ done · esc done"
    : overlay.deleteArmedId === null
      ? width < 100
        ? "↑·↓·tab·↵·/·e·n·s state·x·esc"
        : "↑↓ · tab · ↵ open · / filter · e edit · n new · s state · x delete · esc"
      : width < 100
        ? "↑·↓·tab·↵·/·e·n·s state·x confirms·esc keeps"
        : "↑↓ · tab · ↵ open · / filter · e edit · n new · s state · x confirms · esc keeps";
  const activationCount = keyedFacts.length === 0
    ? ""
    : ` · ${activeKeyedCount}/${keyedFacts.length} keyed`;
  const exhaustionNotice = unevaluatedCount === 0 ? "" : ` · ⚠${unevaluatedCount} unchecked`;
  const resolutionPart = state.payload.path.at(-1);
  const resolutionLine = resolutionPart === undefined
    ? "story"
    : lineName(state.payload, resolutionPart.id);
  const title = `facts · ${state.payload.facts.length} notes · line ${resolutionLine}`
    + `${activationCount}${exhaustionNotice}`
    + panelRange(rows.length, window);
  return placePanel(
    base,
    title,
    boundedContent(content, contentWidth),
    footer,
    width,
    height,
    106,
    {
      rows: state.hitRows,
      targets,
      overrides: chipOverridesByLine,
      footerActions: overlay.filtering
        ? FILTER_FOOTER_ACTIONS
        : width < 120
          ? overlay.deleteArmedId === null
            ? FACTS_COMPACT_FOOTER_ACTIONS
            : FACTS_COMPACT_CONFIRM_FOOTER_ACTIONS
          : overlay.deleteArmedId === null
            ? FACTS_FOOTER_ACTIONS
            : FACTS_CONFIRM_FOOTER_ACTIONS
    }
  );
}

/** C-17: the filter always states `n of m`, so a short list is never mistaken
 *  for a short store. */
function filterLine(value: string, width: number, count: string): FrameLine {
  const prefix = truncate("  › filter: ", Math.max(0, width - 1));
  const suffix = `  ${count}`;
  const valueWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix) - 1);
  return [
    raisedSegment(prefix, "accent · deep"),
    raisedSegment(truncateTail(value, valueWidth), "streaming"),
    raisedSegment(TYPING_CARET, "focus / accent"),
    raisedSegment(suffix, "chrome")
  ];
}

function factsEmptyState(query: string, filtering: boolean, total: number): string {
  if (total === 0) return "no facts yet · n writes one";
  // A committed filter still narrows the list, but the editor that backspace
  // belongs to is closed — `/` is what reopens it.
  if (query.length > 0) {
    return filtering
      ? "no fact matches · backspace widens the filter"
      : "no fact matches · / reopens the filter";
  }
  return "no facts under this tag · tab picks another";
}

function chip(label: string, active: boolean) {
  return active
    ? {
        text: `[ ${label} ]`,
        role: "background" as const,
        background: "accent · deep" as const,
        bold: true
      }
    : raisedSegment(`[ ${label} ]`, "chrome");
}

function renderChipGroup(
  labels: readonly string[],
  active: number,
  contentWidth: number,
  group: "tag" | "scope"
): { lines: FrameLine[]; overrides: HitRegion[][] } {
  const lines: FrameLine[] = [];
  const overrides: HitRegion[][] = [];
  let current: FrameLine = [];
  let currentOverrides: HitRegion[] = [];
  let currentWidth = 0;
  const flush = () => {
    lines.push(current);
    overrides.push(currentOverrides);
    current = [];
    currentOverrides = [];
    currentWidth = 0;
  };
  labels.forEach((label, index) => {
    const text = `[ ${label} ]`;
    const width = visibleWidth(text);
    const gap = current.length === 0 ? 0 : 1;
    if (current.length > 0 && currentWidth + gap + width > Math.max(1, contentWidth - 8)) {
      flush();
    }
    const left = currentWidth + (current.length === 0 ? 0 : 1);
    if (current.length > 0) current.push(segment(" ", "chrome"));
    current.push(chip(label, index === active));
    currentOverrides.push({
      target: group === "scope"
        ? { kind: "chip", index, group }
        : { kind: "chip", index },
      left,
      right: left + width
    });
    currentWidth = left + width;
  });
  if (current.length > 0 || lines.length === 0) flush();
  return { lines, overrides };
}

function scopeLabel(filter: FactScopeFilter): string {
  return filter === "this-line" ? "this line" : filter;
}

function renderFactsDossier(
  base: FrameLine[],
  state: OverlayState & { payload: StoryPayload; hitRows: HitRows },
  width: number,
  height: number,
  fact: StoryPayload["facts"][number]
): FrameComposition {
  const overlay = state.facts!;
  const dossier = overlay.dossier!;
  const pathIds = state.payload.path.map(({ id }) => id);
  const path = factPathProjection(fact, pathIds);
  const entries = factDossierEntries(fact, state.payload, path);
  const selectedIndex = Math.max(0, Math.min(
    Math.max(0, entries.length - 1),
    dossier.stateIndex
  ));
  const resolutionPart = state.payload.path.at(-1);
  const resolutionLine = resolutionPart === undefined
    ? "story"
    : lineName(state.payload, resolutionPart.id);
  const contentWidth = panelHorizontalGeometry(width).contentWidth;
  const diff = dossier.diff ? factStateDiff(fact, selectedIndex) : null;
  const diffRows = !dossier.diff
    ? 0
    : diff === null
      ? 1
      : 3 + diff.omitted.length + diff.added.length;
  const stateBudget = Math.max(1, panelContentRows(height) - 3 - diffRows);
  const stateWindow = panelRowWindow(
    entries.map(() => 1),
    selectedIndex,
    stateBudget
  );
  const visibleEntries = entries.slice(stateWindow.start, stateWindow.end);
  const content: FrameLine[] = [
    [raisedSegment(`  ${factName(fact, pathIds, path)}`, "focus / accent")],
    [raisedSegment(`  path-relative history · seen from line ${resolutionLine}`, "chrome")],
    []
  ];
  const targets: Array<HitTarget | null> = content.map(() => null);
  const overrides: Array<HitRegion[]> = content.map(() => []);
  for (const entry of visibleEntries) {
    const selected = entry.index === selectedIndex;
    const text = isFactEndState(entry.state) ? "✕ ended here" : entry.state.text;
    const relation = entry.effective
      ? "effective here"
      : entry.onCurrentPath
        ? "available on this path"
        : `elsewhere · ${entry.lineName ?? "another line"}`;
    const row = [
      raisedSegment(selected ? "  ▸ " : "    ", selected ? "focus / accent" : "chrome"),
      raisedSegment(`st.${entry.index + 1} `, selected ? "focus / accent" : "chrome"),
      raisedSegment(`${entry.anchorLabel} `, entry.onCurrentPath ? "chrome" : "context warning"),
      raisedSegment(truncate(text.replace(/\s+/g, " "), Math.max(0, contentWidth - 42)),
        isFactEndState(entry.state) ? "context warning" : "prose"),
      raisedSegment(` · ${relation}`, entry.effective ? "focus / accent" : "chrome")
    ];
    content.push(row);
    targets.push({ kind: "list", index: entry.index, rowId: entry.state.id, selected });
  }
  if (entries.length === 0) {
    content.push([raisedSegment("  no states", "prose · dim")]);
    targets.push(null);
  }
  if (dossier.diff) {
    content.push([]);
    targets.push(null);
    if (diff === null) {
      content.push([raisedSegment("  d · select a later state for a diff", "chrome")]);
      targets.push(null);
    } else {
      content.push([raisedSegment("  derived diff · never stored", "chrome")]);
      targets.push(null);
      content.push([raisedSegment(
        `  old] ${truncate(diff.oldText.replace(/\s+/g, " "), Math.max(0, Math.floor(contentWidth / 2) - 7))}`
          + `  new] ${truncate(diff.newText.replace(/\s+/g, " "), Math.max(0, Math.floor(contentWidth / 2) - 7))}`,
        "context warning"
      )]);
      targets.push(null);
      for (const omitted of diff.omitted) {
        content.push([raisedSegment(`  om. ${truncate(omitted, Math.max(0, contentWidth - 6))}`, "context warning")]);
        targets.push(null);
      }
      for (const added of diff.added) {
        content.push([raisedSegment(`  add. ${truncate(added, Math.max(0, contentWidth - 7))}`, "focus / accent")]);
        targets.push(null);
      }
    }
  }
  const footerActions = width < 120 ? DOSSIER_COMPACT_FOOTER_ACTIONS : DOSSIER_FOOTER_ACTIONS;
  const footer = footerActions.map(({ token }) => token).join(" · ");
  const title = `facts · dossier · ${factName(fact, pathIds, path)}`
    + ` · ${entries.length} states · line ${resolutionLine}`
    + panelRange(entries.length, stateWindow);
  return placePanel(
    base,
    title,
    boundedContent(content, contentWidth),
    footer,
    width,
    height,
    106,
    { rows: state.hitRows, targets, footerActions }
  );
}
