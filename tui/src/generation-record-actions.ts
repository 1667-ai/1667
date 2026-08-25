import type { KeyEvent } from "@opentui/core";
import { ApiFailureError } from "./api-error.js";
import { createAtlasLayout } from "./atlas-layout.js";
import { createLaneLayout, laneSelectable } from "./lane-layout.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import { createGenerationRecordDetailCache } from "./generation-record-detail-cache.js";
import { visibleEntryCount } from "./generation-record-pipeline.js";
import type { ResolvedKey } from "./keys.js";
import { createStoryViewModel, rowPart } from "./model.js";
import type {
  GenerationRecordDetailError,
  GenerationRecordDetailState,
  GenerationRecordListState,
  GenerationRecordViewerState,
  RuntimeState
} from "./state.js";
import { projectStreamedPayload } from "./stream-projection.js";

/** Lane `runWhenIdle` (action-runtime.ts) collapses detail-fetch retries
 *  onto. The viewer shows one selection's detail at a time (`selectsRecord`
 *  reads the single live `eventIndex` cursor), so only the latest
 *  selection's retry is ever wanted — a fixed key is correct: it lets a
 *  later selection replace a still-waiting retry outright. */
const DETAIL_FETCH_RETRY_LANE = "generation-record-detail-retry";

/** Open the read-only Generation Record Viewer (RECORD mode) without moving
 *  NAV's or MAP's own focus — `h` from either place, and the palette's
 *  "generation records" command from NAV. */
export async function openGenerationRecordViewer(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const nodeId = focusedGenerationRecordNodeId(state);
  if (nodeId === null) {
    state.toast = "no take to inspect here";
    return;
  }
  const returnMode: GenerationRecordViewerState["returnMode"] = state.mode === "MAP" ? "MAP" : "NAV";
  state.record = {
    nodeId,
    returnMode,
    list: { status: "loading" },
    eventIndex: 0,
    entryIndex: 0,
    scrollTop: -1,
    detail: { status: "idle" },
    cache: createGenerationRecordDetailCache()
  };
  state.mode = "RECORD";
  context.repaint();
  await loadSummaries(state, source, context, nodeId);
}

export function closeGenerationRecordViewer(state: RuntimeState): void {
  const record = state.record;
  if (record === null) return;
  state.mode = record.returnMode;
  state.record = null;
}

/** The node id `h` targets: NAV's own focused part, or MAP's — the path
 *  cursor in Path view, or the cursor row's node in Tree/Mass. A folded
 *  "cold" row names a whole subtree, not one take, so it names nothing. */
export function focusedGenerationRecordNodeId(state: RuntimeState): string | null {
  if (state.mode === "MAP") return focusedMapNodeId(state);
  const view = createStoryViewModel(state.payload, state.stream);
  return rowPart(view, state.focusIndex)?.node.id ?? null;
}

function focusedMapNodeId(state: RuntimeState): string | null {
  const map = state.map;
  if (map === null) return null;
  if (map.view === "path") return map.pathCursorId;
  const payload = projectStreamedPayload(state.payload, state.stream, { includePendingTake: true });
  if (map.view === "tree") {
    const layout = createLaneLayout(payload, {
      now: state.now,
      cursorId: map.treeCursorId,
      showSketches: map.showSketches,
      openedColdFolds: map.openedColdFolds
    });
    const row = layout.allRows.find((candidate) => candidate.cursor) ?? null;
    // A folded cold row names a whole subtree, not one take — the same rule
    // `laneSelectable` uses for cursor placement excludes it too, but `node`,
    // `end`, and `sketch` rows all name exactly one take.
    return row !== null && laneSelectable(row) && row.kind !== "cold" ? row.id : null;
  }
  const layout = createAtlasLayout(payload, {
    now: state.now,
    cursorId: map.treeCursorId,
    showSketches: map.showSketches,
    openedColdFolds: map.openedColdFolds,
    sort: map.massSort
  });
  const row = layout.allRows.find((candidate) => candidate.cursor) ?? null;
  return row !== null && (row.kind === "node" || row.kind === "sketch") ? row.id : null;
}

export function resolveGenerationRecordKey(key: KeyEvent): ResolvedKey {
  if (key.name === "left") return { action: "take-previous" };
  if (key.name === "right") return { action: "take-next" };
  if (key.name === "down") return { action: key.shift ? "scroll-line-down" : "focus-next" };
  if (key.name === "up") return { action: key.shift ? "scroll-line-up" : "focus-previous" };
  if (key.name === "pagedown") return { action: "scroll-down" };
  if (key.name === "pageup") return { action: "scroll-up" };
  if (!key.ctrl && !key.meta && !key.super && !key.shift && key.name === "g") {
    return { action: "top" };
  }
  const shiftedG = key.name === "G" || key.sequence === "G" || (key.name === "g" && key.shift);
  return !key.ctrl && !key.meta && !key.super && shiftedG
    ? { action: "leaf" }
    : { action: "none" };
}

export async function generationRecordAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const record = state.record;
  if (record === null) return;
  if (resolved.action === "cancel") {
    closeGenerationRecordViewer(state);
    return;
  }
  if (resolved.action === "take-previous" || resolved.action === "take-next") {
    await selectEvent(state, source, context, record.eventIndex + (resolved.action === "take-next" ? 1 : -1));
    return;
  }
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    record.entryIndex = Math.max(0, record.entryIndex + (resolved.action === "focus-next" ? 1 : -1));
    record.scrollTop = -1;
  } else if (resolved.action === "scroll-line-down" || resolved.action === "scroll-line-up") {
    const delta = resolved.action === "scroll-line-down" ? 1 : -1;
    record.scrollTop = Math.max(0, Math.max(0, record.scrollTop) + delta);
  } else if (resolved.action === "scroll-down" || resolved.action === "scroll-up") {
    const page = Math.max(1, (context.renderer?.height ?? 7) - 6);
    const delta = resolved.action === "scroll-down" ? page : -page;
    record.scrollTop = Math.max(0, Math.max(0, record.scrollTop) + delta);
  } else if (resolved.action === "top") {
    record.entryIndex = 0;
    record.scrollTop = -1;
  } else if (resolved.action === "leaf") {
    const detail = record.detail.status === "ready" ? record.detail.detail : null;
    record.entryIndex = Math.max(0, visibleEntryCount(detail) - 1);
    record.scrollTop = -1;
  }
}

async function selectEvent(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  index: number
): Promise<void> {
  const record = state.record;
  if (record === null || record.list.status !== "ready" || record.list.summaries.length === 0) return;
  const clamped = Math.max(0, Math.min(record.list.summaries.length - 1, index));
  if (clamped === record.eventIndex) return;
  record.eventIndex = clamped;
  record.entryIndex = 0;
  record.scrollTop = -1;
  await loadSelectedDetail(state, source, context);
}

async function loadSummaries(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  nodeId: string
): Promise<void> {
  const ran = await context.backend.run("loading generation records", async (task) => {
    let list: GenerationRecordListState;
    try {
      const summaries = await source.api.getGenerationRecords(task.storyId, nodeId);
      list = { status: "ready", summaries };
    } catch (error) {
      list = {
        status: "error",
        message: error instanceof Error ? error.message : "Could not load this take's Generation Records."
      };
    }
    if (state.record === null || state.record.nodeId !== nodeId) return;
    state.record.list = list;
    if (list.status === "ready" && list.summaries.length > 0) state.record.eventIndex = list.summaries.length - 1;
  });
  if (!ran) {
    if (state.record !== null && state.record.nodeId === nodeId) {
      state.record.list = { status: "error", message: "Busy. Try again once the current task finishes." };
    }
    return;
  }
  if (state.record !== null && state.record.nodeId === nodeId
    && state.record.list.status === "ready" && state.record.list.summaries.length > 0) {
    await loadSelectedDetail(state, source, context);
  }
}

async function loadSelectedDetail(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  const record = state.record;
  if (record === null || record.list.status !== "ready") return;
  const summary = record.list.summaries[record.eventIndex];
  if (summary === undefined) return;
  const nodeId = record.nodeId;
  const recordId = summary.id;
  const cached = record.cache.get(recordId);
  if (cached !== undefined) {
    record.detail = { status: "ready", recordId, detail: cached };
    return;
  }
  record.detail = { status: "loading", recordId };
  const admitted = await runDetailFetch(state, source, context, nodeId, recordId);
  const current = state.record;
  if (!admitted && current !== null && selectsRecord(current, nodeId, recordId)) {
    // A faster later selection may already own the runtime; retry once it
    // frees up rather than declaring the latest selection busy.
    const wanted = (): GenerationRecordViewerState | null => {
      const record = state.record;
      return record !== null && selectsRecord(record, nodeId, recordId) ? record : null;
    };
    context.backend.runWhenIdle(
      DETAIL_FETCH_RETRY_LANE,
      async () => {
        const record = wanted();
        if (record === null) return;
        // A concurrent fetch may already have cached this record.
        const cached = record.cache.get(recordId);
        if (cached !== undefined) {
          record.detail = { status: "ready", recordId, detail: cached };
          return;
        }
        await runDetailFetch(state, source, context, nodeId, recordId);
      },
      () => wanted() !== null
    );
  }
}

/** Runs the actual detail fetch under the shared runtime and, on success or
 *  failure alike, publishes the result only if this event is still selected
 *  — the same stale-response guard `loadSelectedDetail` always used. */
async function runDetailFetch(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  nodeId: string,
  recordId: string
): Promise<boolean> {
  return context.backend.run("loading generation record", async (task) => {
    let detail: GenerationRecordDetailState;
    try {
      const resolved = await source.api.getGenerationRecord(task.storyId, nodeId, recordId);
      detail = { status: "ready", recordId, detail: resolved };
    } catch (error) {
      detail = { status: "error", recordId, error: classifyDetailError(error) };
    }
    const current = state.record;
    if (current === null || !selectsRecord(current, nodeId, recordId)) return;
    if (detail.status === "ready") current.cache.set(recordId, detail.detail);
    current.detail = detail;
  }, { reportBusy: false });
}

function selectsRecord(record: GenerationRecordViewerState, nodeId: string, recordId: string): boolean {
  return record.nodeId === nodeId
    && record.list.status === "ready"
    && record.list.summaries[record.eventIndex]?.id === recordId;
}

function classifyDetailError(error: unknown): GenerationRecordDetailError {
  if (error instanceof ApiFailureError) {
    if (error.status === 404) return { kind: "missing" };
    return { kind: "failed", message: error.message };
  }
  return { kind: "corrupt", message: error instanceof Error ? error.message : "invalid response" };
}
