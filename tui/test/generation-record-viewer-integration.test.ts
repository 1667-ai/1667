import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { GenerationRecordSummary, ResolvedGenerationRecord } from "../../shared/generation-record.js";
import { handleKey, initialState } from "../src/app.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { ApiHttpError } from "../src/api-error.js";
import { demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { GENERATION_RECORD_DETAIL_CACHE_BOUND } from "../src/generation-record-detail-cache.js";
import type { GenerationRecordViewerState } from "../src/state.js";

/**
 * Integration coverage for states a real dry-run generation cannot
 * deterministically reach: an empty history, a failed list fetch, a detail
 * fetch that 404s or returns a malformed payload, backend-task contention,
 * and — the review's own explicit requirement — that a late, stale async
 * answer never paints over a take or event the writer has since left. The
 * demo fixture's own `StoryApi` (tui/src/demo.ts) stands in here so every
 * response can be driven and timed exactly; `generation-record-viewer-
 * e2e.test.ts` covers the same viewer through a real embedded backend.
 */

function key(name: string, shift = false): KeyEvent {
  return { name, sequence: name, shift, ctrl: false, meta: false } as KeyEvent;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/** The currently loaded resolved record, or null while idle, loading, or
 *  errored — the same narrowing `screens/generation-record-viewer.ts` and
 *  `generation-record-actions.ts` do at each of their own call sites. */
function resolvedDetail(record: GenerationRecordViewerState | null | undefined): ResolvedGenerationRecord | null {
  return record != null && record.detail.status === "ready" ? record.detail.detail : null;
}

function harness() {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const press = (name: string, shift = false) =>
    handleKey(key(name, shift), state, source, cache, () => {}, async () => {}, () => {});
  return { source, state, cache, press };
}

/** Like `harness()`, but wires one persistent `ActionRuntime` across every
 *  key press instead of the per-call default — matching how the real app
 *  wires a single long-lived backend (`app.ts`'s render loop), so
 *  `backend.whenIdle()` waiters registered by one press actually see a
 *  later press's task release the runtime. */
function persistentBackendHarness() {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => {});
  const press = (name: string, shift = false) =>
    handleKey(
      key(name, shift), state, source, cache, () => {}, async () => {}, () => {},
      null, () => undefined, () => undefined, backend
    );
  return { source, state, cache, backend, press };
}

const SUMMARY_OLD: GenerationRecordSummary = { id: "r-old", kind: "continue", createdAt: "2026-01-01T00:00:00.000Z" };
const SUMMARY_NEW: GenerationRecordSummary = { id: "r-new", kind: "append", createdAt: "2026-01-02T00:00:00.000Z" };

function record(kind: ResolvedGenerationRecord["kind"]): ResolvedGenerationRecord {
  return {
    format: "1667-generation-record",
    schemaVersion: 1,
    kind,
    createdAt: "2026-01-01T00:00:00.000Z",
    provider: { provider: "dry-run", model: "dry-run" },
    effective: { wireProtocol: "dry-run", fields: [], adjustments: [] },
    prompt: {
      operation: "continue",
      entries: [{ role: "user", stability: "volatile", kind: "request", source: "text", text: "Continue." }]
    }
  };
}

function missingError(): ApiHttpError {
  return new ApiHttpError({
    kind: "plain",
    code: "not-found",
    message: "This take has no such Generation Record.",
    status: 404
  });
}

function serverError(): ApiHttpError {
  return new ApiHttpError({ kind: "plain", code: "internal", message: "database unavailable", status: 500 });
}

describe("generation record viewer: empty and failure states keep the known take", () => {
  test("no records renders an honest empty state", async () => {
    const { source, state, cache, press } = harness();
    source.api.getGenerationRecords = async () => [];
    await press("h");
    expect(state.mode).toBe("RECORD");
    expect(state.record?.list).toEqual({ status: "ready", summaries: [] });
    expect(state.record?.detail).toEqual({ status: "idle" });
    const frame = frameText(renderStoryScreen(state, { width: 100, height: 30, wrapCache: cache }).lines);
    expect(frame).toContain("This take has no Generation Records.");
    // The header still identifies the known take even with nothing to show.
    expect(frame).toContain(state.record?.nodeId);
  });

  test("a list fetch failure surfaces the reason instead of hanging", async () => {
    const { source, state, cache, press } = harness();
    source.api.getGenerationRecords = async () => { throw new Error("network unreachable"); };
    await press("h");
    expect(state.record?.list).toEqual({ status: "error", message: "network unreachable" });
    const frame = frameText(renderStoryScreen(state, { width: 100, height: 30, wrapCache: cache }).lines);
    expect(frame).toContain("Could not load this take's Generation Records. network unreachable");
  });

  test("a missing (404) detail renders distinctly from other failures", async () => {
    const { source, state, cache, press } = harness();
    source.api.getGenerationRecords = async () => [SUMMARY_OLD];
    source.api.getGenerationRecord = async () => { throw missingError(); };
    await press("h");
    expect(state.record?.detail).toEqual({ status: "error", recordId: SUMMARY_OLD.id, error: { kind: "missing" } });
    const frame = frameText(renderStoryScreen(state, { width: 100, height: 30, wrapCache: cache }).lines);
    expect(frame).toContain("no longer available");
  });

  test("a non-404 failure renders as failed, carrying the server's own message", async () => {
    const { source, state, cache, press } = harness();
    source.api.getGenerationRecords = async () => [SUMMARY_OLD];
    source.api.getGenerationRecord = async () => { throw serverError(); };
    await press("h");
    expect(state.record?.detail).toEqual({
      status: "error",
      recordId: SUMMARY_OLD.id,
      error: { kind: "failed", message: "database unavailable" }
    });
    const frame = frameText(renderStoryScreen(state, { width: 100, height: 30, wrapCache: cache }).lines);
    expect(frame).toContain("database unavailable");
  });

  test("a decode failure renders as corrupt, distinct from a missing or failed record", async () => {
    const { source, state, cache, press } = harness();
    source.api.getGenerationRecords = async () => [SUMMARY_OLD];
    source.api.getGenerationRecord = async () => {
      throw new Error("The server returned an invalid Generation Record. kind is invalid");
    };
    await press("h");
    expect(state.record?.detail).toEqual({
      status: "error",
      recordId: SUMMARY_OLD.id,
      error: { kind: "corrupt", message: "The server returned an invalid Generation Record. kind is invalid" }
    });
    const frame = frameText(renderStoryScreen(state, { width: 100, height: 30, wrapCache: cache }).lines);
    expect(frame).toContain("invalid Generation Record");
  });

  test("a busy backend task refuses the list fetch without crashing", async () => {
    const { source, state, press } = harness();
    state.backendTask = { id: 999, kind: "action", label: "something else", storyId: state.payload.id };
    await press("h");
    expect(state.record?.list).toEqual({
      status: "error",
      message: "Busy. Try again once the current task finishes."
    });
    state.backendTask = null;
  });
});

describe("generation record viewer: stale async responses never paint over a newer selection", () => {
  test("closing the viewer while the list is still loading discards the late answer", async () => {
    const { source, state, press } = harness();
    const gate = deferred<GenerationRecordSummary[]>();
    source.api.getGenerationRecords = async () => await gate.promise;
    const opening = press("h");
    expect(state.record?.list).toEqual({ status: "loading" });

    await press("escape");
    expect(state.mode).toBe("NAV");
    expect(state.record).toBe(null);

    gate.resolve([SUMMARY_OLD]);
    await opening;
    // The list answer arrived only after the viewer was already closed —
    // it must never resurrect it.
    expect(state.record).toBe(null);
    expect(state.mode).toBe("NAV");
  });

  test("switching events discards a slower, older event's late detail", async () => {
    const { source, state, press } = harness();
    source.api.getGenerationRecords = async () => [SUMMARY_OLD, SUMMARY_NEW];
    source.api.getGenerationRecord = async (_storyId, _nodeId, recordId) =>
      recordId === SUMMARY_NEW.id ? record("append") : Promise.reject(new Error("not requested yet"));
    await press("h");
    expect(state.record?.eventIndex).toBe(1);
    expect(resolvedDetail(state.record)?.kind).toBe("append");

    const gate = deferred<ResolvedGenerationRecord>();
    source.api.getGenerationRecord = async (_storyId, _nodeId, recordId) => {
      if (recordId === SUMMARY_OLD.id) return await gate.promise;
      throw new Error(`unexpected record id ${recordId}`);
    };
    const leaving = press("left");
    expect(state.record?.eventIndex).toBe(0);
    expect(state.record?.detail).toEqual({ status: "loading", recordId: SUMMARY_OLD.id });

    // Back to the newer event before the older one's fetch ever settles —
    // its own detail is already cached from the initial open, so this
    // resolves without touching the network at all.
    await press("right");
    expect(state.record?.eventIndex).toBe(1);
    expect(resolvedDetail(state.record)?.kind).toBe("append");

    gate.resolve(record("continue"));
    await leaving;
    // The stale older-event answer must not overwrite the current selection.
    expect(state.record?.eventIndex).toBe(1);
    expect(resolvedDetail(state.record)?.kind).toBe("append");
  });

  test("rapid switching past a still-loading event keeps the newest selection loading, not stuck busy", async () => {
    // A persistent backend (not a fresh one per key press) so a retry queued
    // by one press can see a later press's task actually free the runtime —
    // exactly how the real app wires one long-lived `ActionRuntime`.
    const { source, state, press } = persistentBackendHarness();
    const SUMMARY_MID: GenerationRecordSummary = {
      id: "r-mid",
      kind: "continue",
      createdAt: "2026-01-01T12:00:00.000Z"
    };
    source.api.getGenerationRecords = async () => [SUMMARY_OLD, SUMMARY_MID, SUMMARY_NEW];
    source.api.getGenerationRecord = async (_storyId, _nodeId, recordId) =>
      recordId === SUMMARY_NEW.id ? record("append") : Promise.reject(new Error("not requested yet"));
    await press("h");
    expect(state.record?.eventIndex).toBe(2);
    expect(resolvedDetail(state.record)?.kind).toBe("append");

    const midGate = deferred<ResolvedGenerationRecord>();
    const oldGate = deferred<ResolvedGenerationRecord>();
    source.api.getGenerationRecord = async (_storyId, _nodeId, recordId) => {
      if (recordId === SUMMARY_MID.id) return await midGate.promise;
      if (recordId === SUMMARY_OLD.id) return await oldGate.promise;
      throw new Error(`unexpected record id ${recordId}`);
    };

    // First Left: MID's detail load starts and owns the shared runtime.
    const toMid = press("left");
    expect(state.record?.eventIndex).toBe(1);
    expect(state.record?.detail).toEqual({ status: "loading", recordId: SUMMARY_MID.id });

    // A second, rapid Left commits OLD as the selection while MID's load is
    // still in flight and still owns the runtime — the load this action
    // starts is immediately refused as busy.
    const toOld = press("left");
    expect(state.record?.eventIndex).toBe(0);
    // Regression: the newest selection must stay loading, queued to retry
    // once the runtime frees up — not stuck showing a "Busy" error forever,
    // since nothing else will ever retry it on the writer's behalf.
    expect(state.record?.detail).toEqual({ status: "loading", recordId: SUMMARY_OLD.id });

    oldGate.resolve(record("rewrite-take"));
    midGate.resolve(record("continue"));
    await toMid;
    await toOld;
    // Both `press` calls settle as soon as their own load either lands or is
    // queued to retry — neither one waits out the retry loop itself, so
    // drain the microtask queue until the queued retry has had its turn.
    for (let turn = 0; turn < 40 && state.record?.detail.status === "loading"; turn += 1) {
      await Promise.resolve();
    }

    // MID's own late response was discarded — OLD, not MID, is current —
    // and the queued retry landed OLD's own detail once the runtime freed.
    expect(state.record?.eventIndex).toBe(0);
    expect(state.record?.detail).toEqual({
      status: "ready",
      recordId: SUMMARY_OLD.id,
      detail: record("rewrite-take")
    });
  });

});

describe("generation record viewer: the detail cache stays bounded while paging", () => {
  function summaries(count: number): GenerationRecordSummary[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `r-${index}`,
      kind: "continue",
      createdAt: new Date(2026, 0, index + 1).toISOString()
    }));
  }

  function countingDetailFetch(source: ReturnType<typeof demoAppSource>) {
    const fetchCounts = new Map<string, number>();
    source.api.getGenerationRecord = async (_storyId, _nodeId, recordId) => {
      fetchCounts.set(recordId, (fetchCounts.get(recordId) ?? 0) + 1);
      return record("continue");
    };
    return fetchCounts;
  }

  test("paging back and forth within the bound never re-fetches an already-seen event", async () => {
    const { source, state, press } = harness();
    const list = summaries(GENERATION_RECORD_DETAIL_CACHE_BOUND);
    source.api.getGenerationRecords = async () => list;
    const fetchCounts = countingDetailFetch(source);

    await press("h");
    expect(state.record?.eventIndex).toBe(list.length - 1);
    for (let i = list.length - 1; i > 0; i -= 1) await press("left");
    expect(state.record?.eventIndex).toBe(0);
    // Walking every event exactly fills the cache to its bound — one entry
    // per event, none evicted yet — so the walk back must be all hits.
    for (let i = 0; i < list.length - 1; i += 1) await press("right");
    expect(state.record?.eventIndex).toBe(list.length - 1);

    expect(fetchCounts.size).toBe(list.length);
    for (const count of fetchCounts.values()) expect(count).toBe(1);
  });

  test("paging one event past the bound evicts the longest-untouched entry, forcing a re-fetch", async () => {
    const { source, state, press } = harness();
    // One more event than the cache holds, so walking every event once
    // over-fills it by exactly one entry.
    const list = summaries(GENERATION_RECORD_DETAIL_CACHE_BOUND + 1);
    source.api.getGenerationRecords = async () => list;
    const fetchCounts = countingDetailFetch(source);
    const newestId = list[list.length - 1]!.id;

    await press("h");
    expect(state.record?.eventIndex).toBe(list.length - 1);
    expect(fetchCounts.get(newestId)).toBe(1);

    // Walk all the way back to the oldest event. This caches every other
    // event along the way — one more than the bound allows — so the one
    // entry never touched again after its own fetch (the newest event,
    // opened first and then immediately left behind) is the one that falls
    // out.
    for (let i = list.length - 1; i > 0; i -= 1) await press("left");
    expect(state.record?.eventIndex).toBe(0);

    // Walking back to the newest event re-visits every entry still cached
    // (no further eviction) until it reaches the one entry that was
    // evicted, which must be fetched again from the network.
    for (let i = 0; i < list.length - 1; i += 1) await press("right");
    expect(state.record?.eventIndex).toBe(list.length - 1);

    expect(fetchCounts.get(newestId)).toBe(2);
  });
});
