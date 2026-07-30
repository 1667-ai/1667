import {
  assertChapterBreak,
  assertPromptReadyStoryPayload,
  assertStoryNode
} from "../../shared/types.js";
import type {
  ChapterBreak,
  ModelServerCheckResult,
  StoryNode,
  StoryPayload,
  StorySummary
} from "../../shared/types.js";
import type { SettingsDocumentV2 } from "../../shared/settings-v2-types.js";
import {
  decodeSettingsViewResponse as decodeSettingsViewEnvelope
} from "../../shared/settings-response-decoder.js";
export {
  decodeGenerationSettingsResponse,
  decodeSettingsMutationResult
} from "../../shared/settings-response-decoder.js";
import { assertNfcJsonStrings } from "../../server/canonical-json.js";
import { MAX_SETTINGS_DOCUMENT_BYTES } from "../../server/settings-v2-scalars.js";
import { validateSettingsDocumentV2 } from "../../server/settings-v2-validation.js";
import { parseStoryAggregateVersion } from "../../shared/story-aggregate-version.js";
import type { StoryCatalogPage } from "../../shared/story-catalog.js";
import type { SearchHit, SearchResponse } from "../../shared/story-search.js";

export interface RemovedChapterBreak {
  break: ChapterBreak;
  summaries: StoryNode[];
}

export function decodeSettingsViewResponse(value: unknown) {
  return decodeSettingsViewEnvelope(value, decodeSettingsDocumentResponse);
}

export function decodeStorySummariesResponse(value: unknown): StorySummary[] {
  if (!Array.isArray(value)) throw new Error("The server did not return a story-list response.");
  return value.map((entry) => {
    const summary = responseRecord(entry, "story summary");
    return {
      id: stringField(summary, "id", "story summary"),
      title: stringField(summary, "title", "story summary"),
      updatedAt: stringField(summary, "updatedAt", "story summary"),
      partCount: nonNegativeIntegerField(summary, "partCount", "story summary"),
      words: nonNegativeIntegerField(summary, "words", "story summary"),
      forked: booleanField(summary, "forked", "story summary"),
      lineCount: nonNegativeIntegerField(summary, "lineCount", "story summary"),
      ...(summary.aggregateVersion === undefined
        ? {}
        : {
            aggregateVersion: parseStoryAggregateVersion(
              summary.aggregateVersion,
              "story summary.aggregateVersion"
            )
          })
    };
  });
}

export function decodeStoryCatalogPageResponse(
  value: unknown
): StoryCatalogPage {
  const response = responseRecord(value, "story catalog page");
  if (typeof response.scanId !== "string"
    || !/^[0-9a-f]{32}$/.test(response.scanId)) {
    invalidField("story catalog page", "scanId");
  }
  if (response.cursor !== null
    && (typeof response.cursor !== "string"
      || !/^[0-9a-f]{64}$/.test(response.cursor))) {
    invalidField("story catalog page", "cursor");
  }
  if (typeof response.done !== "boolean"
    || response.done !== (response.cursor === null)) {
    invalidField("story catalog page", "done");
  }
  return {
    scanId: response.scanId,
    items: decodeStorySummariesResponse(response.items),
    cursor: response.cursor,
    done: response.done
  };
}

export function decodeSearchResponse(value: unknown): SearchResponse {
  const response = responseRecord(value, "search");
  const scope = response.scope;
  if (scope !== "tree" && scope !== "vault") invalidField("search response", "scope");
  if (!Array.isArray(response.hits)) invalidField("search response", "hits");
  return {
    query: stringField(response, "query", "search response"),
    scope,
    caseSensitive: booleanField(response, "caseSensitive", "search response"),
    hits: response.hits.map(decodeSearchHit),
    capped: booleanField(response, "capped", "search response"),
    storiesSearched: nonNegativeIntegerField(response, "storiesSearched", "search response")
  };
}

function decodeSearchHit(value: unknown): SearchHit {
  const hit = responseRecord(value, "search hit");
  const kind = hit.kind;
  if (kind !== "prose" && kind !== "prompt" && kind !== "fact") {
    invalidField("search hit", "kind");
  }
  const snippet = stringField(hit, "snippet", "search hit");
  const context = stringField(hit, "context", "search hit");
  const snippetMatch = nonNegativeIntegerField(hit, "snippetMatch", "search hit");
  const matchLength = nonNegativeIntegerField(hit, "matchLength", "search hit");
  const contextMatch = nonNegativeIntegerField(hit, "contextMatch", "search hit");
  // Offsets index into the strings beside them. A pair that does not fit would
  // paint a highlight over text that is not the match.
  if (snippetMatch + matchLength > snippet.length) invalidField("search hit", "snippetMatch");
  if (contextMatch + matchLength > context.length) invalidField("search hit", "contextMatch");
  return {
    storyId: stringField(hit, "storyId", "search hit"),
    storyTitle: stringField(hit, "storyTitle", "search hit"),
    kind,
    targetId: stringField(hit, "targetId", "search hit"),
    depth: nonNegativeIntegerField(hit, "depth", "search hit"),
    snippet,
    snippetMatch,
    matchLength,
    context,
    contextMatch
  };
}

export function decodeDeleteStoryResponse(value: unknown): { ok: true } {
  const response = responseRecord(value, "story deletion");
  if (!booleanField(response, "ok", "story deletion response")) {
    invalidField("story deletion response", "ok");
  }
  return { ok: true };
}

export function decodeModelServerCheckResponse(value: unknown): ModelServerCheckResult {
  const response = responseRecord(value, "model-server check");
  const state = response.state;
  if (state !== "ready" && state !== "warning" && state !== "error") {
    invalidField("model-server check response", "state");
  }
  return {
    state,
    message: stringField(response, "message", "model-server check response")
  };
}

export function decodeContextWindowResponse(value: unknown): { contextWindow: number | null } {
  const response = responseRecord(value, "context-window probe");
  return {
    contextWindow: nullablePositiveIntegerField(response, "contextWindow", "context-window probe response")
  };
}

export function decodeUnknownOutcomeStatusResponse(
  value: unknown
):
  | {
      state: "pending";
      aggregateVersion: import("../../shared/story-aggregate-version.js").StoryAggregateVersion;
      deleted: boolean;
    }
  | { state: "resolved"; deleted: boolean } {
  const response = responseRecord(value, "unknown-outcome status");
  if (response.state === "resolved") {
    return {
      state: "resolved",
      deleted: booleanField(response, "deleted", "unknown-outcome status")
    };
  }
  if (response.state !== "pending") {
    invalidField("unknown-outcome status", "state");
  }
  return {
    state: "pending",
    aggregateVersion: parseStoryAggregateVersion(
      response.aggregateVersion,
      "unknown-outcome status.aggregateVersion"
    ),
    deleted: booleanField(response, "deleted", "unknown-outcome status")
  };
}

export function decodeStoryResponse(value: unknown): StoryPayload {
  assertPromptReadyStoryPayload(value);
  return value;
}

export function decodeChapterBreakCreatedResponse(
  value: unknown
): { payload: StoryPayload; breakId: string } {
  const envelope = responseRecord(value, "chapter-break creation");
  const payload = envelope.payload;
  assertPromptReadyStoryPayload(payload);
  if (typeof envelope.breakId !== "string") {
    throw new Error("The server returned invalid chapter-break creation response.breakId.");
  }
  return { payload, breakId: envelope.breakId };
}

export function decodeChapterBreakRemovalPreview(
  value: unknown
): {
  removedFingerprint: string;
  aggregateVersion: import("../../shared/story-aggregate-version.js").StoryAggregateVersion;
} {
  const record = responseRecord(value, "chapter-break removal preview");
  if (typeof record.removedFingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(record.removedFingerprint)) {
    throw new Error(
      "The server returned invalid chapter-break removal preview.removedFingerprint."
    );
  }
  return {
    removedFingerprint: record.removedFingerprint,
    aggregateVersion: parseStoryAggregateVersion(
      record.aggregateVersion,
      "chapter-break removal preview.aggregateVersion"
    )
  };
}

export function decodeChapterBreakRemovedResponse(
  value: unknown
): { payload: StoryPayload; removed: RemovedChapterBreak } {
  const envelope = responseRecord(value, "chapter-break removal");
  const payload = envelope.payload;
  assertPromptReadyStoryPayload(payload);
  const removed = responseRecord(envelope.removed, "removed chapter-break");
  const chapterBreak = removed.break;
  assertChapterBreak(chapterBreak);
  if (!Array.isArray(removed.summaries)) {
    throw new Error("The server returned invalid removed chapter-break.summaries.");
  }
  const summaries = removed.summaries.map((summary) => {
    assertStoryNode(summary);
    return summary;
  });
  return { payload, removed: { break: chapterBreak, summaries } };
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The server did not return a ${label} response envelope.`);
  }
  return value as Record<string, unknown>;
}

/** TUI can connect to a separately launched server, so compose the shared
 * envelope decoder with the canonical pure document validator. Persistence,
 * hashing, and file-codec modules stay out of the client dependency graph. */
function decodeSettingsDocumentResponse(value: unknown): SettingsDocumentV2 {
  assertNfcJsonStrings(value, "settings document");
  const document = validateSettingsDocumentV2(value);
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_SETTINGS_DOCUMENT_BYTES) {
    throw new Error(`Settings document exceeds its ${MAX_SETTINGS_DOCUMENT_BYTES}-byte size limit`);
  }
  return deepFreeze(document);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function stringField(value: Record<string, unknown>, field: string, label: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") invalidField(label, field);
  return candidate;
}

function numberField(value: Record<string, unknown>, field: string, label: string): number {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) invalidField(label, field);
  return candidate;
}

function positiveIntegerField(value: Record<string, unknown>, field: string, label: string): number {
  const candidate = numberField(value, field, label);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) invalidField(label, field);
  return candidate;
}

function nonNegativeIntegerField(value: Record<string, unknown>, field: string, label: string): number {
  const candidate = numberField(value, field, label);
  if (!Number.isSafeInteger(candidate) || candidate < 0) invalidField(label, field);
  return candidate;
}

function nullablePositiveIntegerField(
  value: Record<string, unknown>,
  field: string,
  label: string
): number | null {
  if (value[field] === null) return null;
  return positiveIntegerField(value, field, label);
}

function booleanField(value: Record<string, unknown>, field: string, label: string): boolean {
  const candidate = value[field];
  if (typeof candidate !== "boolean") invalidField(label, field);
  return candidate;
}

function invalidField(label: string, field: string): never {
  throw new Error(`The server returned invalid ${label}.${field}.`);
}
