import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { GenerationRecordSummary, ResolvedGenerationRecord } from "../../shared/generation-record.js";
import { handleKey, initialState } from "../src/app.js";
import { ApiHttpError } from "../src/api-error.js";
import { demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

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

function harness() {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const press = (name: string, shift = false) =>
    handleKey(key(name, shift), state, source, cache, () => {}, async () => {}, () => {});
  return { source, state, cache, press };
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
    expect(state.record?.summaries).toEqual([]);
    expect(state.record?.detail).toBe(null);
    const frame = frameText(renderStoryScreen(state, { width: 100, height: 30, wrapCache: cache }).lines);
    expect(frame).toContain("This take has no Generation Records.");
    // The header still identifies the known take even with nothing to show.
    expect(frame).toContain(state.record?.nodeId);
  });

  test("a list fetch failure surfaces the reason instead of hanging", async () => {
    const { source, state, cache, press } = harness();
    source.api.getGenerationRecords = async () => { throw new Error("network unreachable"); };
    await press("h");
    expect(state.record?.listError).toBe("network unreachable");
    const frame = frameText(renderStoryScreen(state, { width: 100, height: 30, wrapCache: cache }).lines);
    expect(frame).toContain("Could not load this take's Generation Records. network unreachable");
  });

  test("a missing (404) detail renders distinctly from other failures", async () => {
    const { source, state, cache, press } = harness();
    source.api.getGenerationRecords = async () => [SUMMARY_OLD];
    source.api.getGenerationRecord = async () => { throw missingError(); };
    await press("h");
    expect(state.record?.detailError).toEqual({ kind: "missing" });
    const frame = frameText(renderStoryScreen(state, { width: 100, height: 30, wrapCache: cache }).lines);
    expect(frame).toContain("no longer available");
  });

  test("a non-404 failure renders as failed, carrying the server's own message", async () => {
    const { source, state, cache, press } = harness();
    source.api.getGenerationRecords = async () => [SUMMARY_OLD];
    source.api.getGenerationRecord = async () => { throw serverError(); };
    await press("h");
    expect(state.record?.detailError?.kind).toBe("failed");
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
    expect(state.record?.detailError?.kind).toBe("corrupt");
    const frame = frameText(renderStoryScreen(state, { width: 100, height: 30, wrapCache: cache }).lines);
    expect(frame).toContain("invalid Generation Record");
  });

  test("a busy backend task refuses the list fetch without crashing", async () => {
    const { source, state, press } = harness();
    state.backendTask = { id: 999, kind: "action", label: "something else", storyId: state.payload.id };
    await press("h");
    expect(state.record?.listLoading).toBe(false);
    expect(state.record?.listError).toContain("Busy");
    state.backendTask = null;
  });
});

describe("generation record viewer: stale async responses never paint over a newer selection", () => {
  test("closing the viewer while the list is still loading discards the late answer", async () => {
    const { source, state, press } = harness();
    const gate = deferred<GenerationRecordSummary[]>();
    source.api.getGenerationRecords = async () => await gate.promise;
    const opening = press("h");
    expect(state.record?.listLoading).toBe(true);

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
    expect(state.record?.detail?.kind).toBe("append");

    const gate = deferred<ResolvedGenerationRecord>();
    source.api.getGenerationRecord = async (_storyId, _nodeId, recordId) => {
      if (recordId === SUMMARY_OLD.id) return await gate.promise;
      throw new Error(`unexpected record id ${recordId}`);
    };
    const leaving = press("left");
    expect(state.record?.eventIndex).toBe(0);
    expect(state.record?.detailLoading).toBe(true);

    // Back to the newer event before the older one's fetch ever settles —
    // its own detail is already cached from the initial open, so this
    // resolves without touching the network at all.
    await press("right");
    expect(state.record?.eventIndex).toBe(1);
    expect(state.record?.detail?.kind).toBe("append");

    gate.resolve(record("continue"));
    await leaving;
    // The stale older-event answer must not overwrite the current selection.
    expect(state.record?.eventIndex).toBe(1);
    expect(state.record?.detail?.kind).toBe("append");
  });

});
