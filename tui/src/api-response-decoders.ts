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
  SAMPLING_BIAS_VARIANT_VALUES,
  TOKENIZER_UNAVAILABLE_CAUSE_VALUES,
  type SamplingBiasEntryResolution,
  type SamplingBiasResolutionResult,
  type SamplingBiasVariant,
  type SamplingBiasVariantOutcome,
  type SamplingBiasVariantResolution,
  type TokenizerUnavailableCause
} from "../../shared/sampling-capabilities.js";
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

export function decodeSamplingBiasResolutionResponse(
  value: unknown
): SamplingBiasResolutionResult {
  const label = "sampling bias resolution";
  const response = responseRecord(value, label);
  const kind = response.kind;
  if (kind === "tokenizer-unavailable") {
    return { kind, cause: decodeTokenizerUnavailableCause(response.cause, label) };
  }
  if (kind !== "resolved") invalidField(label, "kind");
  return {
    kind: "resolved",
    logitBias: decodeLogitBiasRecord(response.logitBias, label),
    phraseBias: decodeSamplingBiasEntryList(response.phraseBias, label),
    bannedStrings: decodeSamplingBiasEntryList(response.bannedStrings, label),
    resolvedEntryCount: nonNegativeIntegerField(response, "resolvedEntryCount", label)
  };
}

function decodeTokenizerUnavailableCause(value: unknown, label: string): TokenizerUnavailableCause {
  if (typeof value !== "string"
    || !(TOKENIZER_UNAVAILABLE_CAUSE_VALUES as readonly string[]).includes(value)
  ) {
    invalidField(label, "cause");
  }
  return value as TokenizerUnavailableCause;
}

function decodeLogitBiasRecord(value: unknown, label: string): Readonly<Record<string, number>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidField(label, "logitBias");
  }
  const record = value as Record<string, unknown>;
  for (const weight of Object.values(record)) {
    if (typeof weight !== "number" || !Number.isFinite(weight)) invalidField(label, "logitBias");
  }
  return record as Readonly<Record<string, number>>;
}

function decodeSamplingBiasEntryList(
  value: unknown,
  label: string
): readonly SamplingBiasEntryResolution[] {
  if (!Array.isArray(value)) invalidField(label, "entries");
  return value.map((entry) => decodeSamplingBiasEntry(entry, `${label} entry`));
}

function decodeSamplingBiasEntry(value: unknown, label: string): SamplingBiasEntryResolution {
  const record = responseRecord(value, label);
  const phrase = stringField(record, "phrase", label);
  const variants = decodeSamplingBiasVariantList(record.variants, label);
  if (record.kind === "rejected") return { kind: "rejected", phrase, variants };
  if (record.kind === "shadowed") {
    return {
      kind: "shadowed",
      phrase,
      variants,
      tokenIds: decodeTokenIdArray(record.tokenIds, label),
      shadowedBy: decodeShadowedBy(record.shadowedBy, label)
    };
  }
  if (record.kind !== "resolved") invalidField(label, "kind");
  return { kind: "resolved", phrase, variants, tokenIds: decodeTokenIdArray(record.tokenIds, label) };
}

function decodeTokenIdArray(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value) || value.some((id) => !Number.isSafeInteger(id) || id < 0)) {
    invalidField(label, "tokenIds");
  }
  return value as readonly number[];
}

function decodeShadowedBy(
  value: unknown,
  label: string
): { readonly source: "phraseBias" | "bannedStrings"; readonly phrase: string } {
  const record = responseRecord(value, `${label} shadowedBy`);
  const source = record.source;
  if (source !== "phraseBias" && source !== "bannedStrings") {
    invalidField(`${label} shadowedBy`, "source");
  }
  return { source, phrase: stringField(record, "phrase", `${label} shadowedBy`) };
}

function decodeSamplingBiasVariantList(
  value: unknown,
  label: string
): readonly SamplingBiasVariantResolution[] {
  if (!Array.isArray(value)) invalidField(label, "variants");
  return value.map((entry) => decodeSamplingBiasVariantResolution(entry, `${label} variant`));
}

function decodeSamplingBiasVariantResolution(
  value: unknown,
  label: string
): SamplingBiasVariantResolution {
  const record = responseRecord(value, label);
  const variant = record.variant;
  if (typeof variant !== "string"
    || !(SAMPLING_BIAS_VARIANT_VALUES as readonly string[]).includes(variant)
  ) {
    invalidField(label, "variant");
  }
  const text = stringField(record, "text", label);
  return {
    variant: variant as SamplingBiasVariant,
    text,
    outcome: decodeSamplingBiasVariantOutcome(record.outcome, label)
  };
}

function decodeSamplingBiasVariantOutcome(value: unknown, label: string): SamplingBiasVariantOutcome {
  const record = responseRecord(value, `${label} outcome`);
  if (record.kind === "unencodable") return { kind: "unencodable" };
  if (record.kind === "single-token") {
    const tokenId = record.tokenId;
    if (!Number.isSafeInteger(tokenId) || (tokenId as number) < 0) {
      invalidField(`${label} outcome`, "tokenId");
    }
    return { kind: "single-token", tokenId: tokenId as number };
  }
  if (record.kind === "multi-token") {
    const tokenIds = record.tokenIds;
    if (!Array.isArray(tokenIds) || tokenIds.some((id) => !Number.isSafeInteger(id) || id < 0)) {
      invalidField(`${label} outcome`, "tokenIds");
    }
    return { kind: "multi-token", tokenIds: tokenIds as readonly number[] };
  }
  invalidField(`${label} outcome`, "kind");
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
