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
import type { FactBudgetDrop } from "../../shared/fact-budget.js";
import { parseTokenProbabilities, type TokenProbabilityRecord } from "../../shared/token-probabilities.js";
import { parseReasoning, type ReasoningRecord } from "../../shared/reasoning.js";
import type { SettingsDocumentV2 } from "../../shared/settings-v2-types.js";
import {
  SAMPLING_BIAS_SCOPE_VALUES,
  SAMPLING_BIAS_VARIANT_VALUES,
  TOKENIZER_UNAVAILABLE_CAUSE_VALUES,
  type SamplingBiasEntryResolution,
  type SamplingBiasNativeBannedStringResolution,
  type SamplingBiasResolutionResult,
  type SamplingBiasScope,
  type SamplingBiasShadowOwner,
  type SamplingBiasVariant,
  type SamplingBiasVariantOutcome,
  type SamplingBiasVariantResolution,
  type TokenizerUnavailableCause
} from "../../shared/sampling-capabilities.js";
import {
  COUNTED_TOKENIZE_SOURCE_VALUES,
  TOKEN_COUNT_FALLBACK_VALUES,
  TOKENIZE_SOURCE_CONTRACTS,
  type PromptTokenCount
} from "../../shared/tokenize-source.js";
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
    nativeBannedStrings: decodeNativeBannedStringList(response.nativeBannedStrings, label),
    resolvedEntryCount: nonNegativeIntegerField(response, "resolvedEntryCount", label)
  };
}

function decodeNativeBannedStringList(
  value: unknown,
  label: string
): readonly SamplingBiasNativeBannedStringResolution[] {
  if (!Array.isArray(value)) invalidField(label, "nativeBannedStrings");
  return value.map((entry) => decodeNativeBannedString(entry, `${label} native banned string`));
}

function decodeNativeBannedString(
  value: unknown,
  label: string
): SamplingBiasNativeBannedStringResolution {
  const record = responseRecord(value, label);
  const phrase = stringField(record, "phrase", label);
  const scope = decodeSamplingBiasScope(record.scope, label);
  if (record.kind === "native") return { kind: "native", phrase, scope };
  // "blocked" (same-scope, issue #311 second pass) and "overridden"
  // (cross-scope, issue #311 review, third pass, finding G) both name
  // whoever actually won the contested token — reusing `decodeShadowOwner`,
  // the same decoder a "shadowed"/"overridden" SamplingBiasEntryResolution's
  // own conflicts already use, since the winner is not always a phraseBias
  // entry (it can be another banned string, or an explicit numeric
  // logitBias entry).
  if (record.kind !== "blocked" && record.kind !== "overridden") invalidField(label, "kind");
  return { kind: record.kind, phrase, scope, conflict: decodeShadowOwner(record.conflict, label) };
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
  const scope = decodeSamplingBiasScope(record.scope, label);
  // A native banned string (issue #311) is never a member of this union —
  // see `decodeNativeBannedStringList` above, and the doc comment on
  // `SamplingBiasEntryResolution` (shared/sampling-phrase-resolution.ts) for
  // why. Every kind reachable here carries variants unconditionally.
  const variants = decodeSamplingBiasVariantList(record.variants, label);
  if (record.kind === "rejected") return { kind: "rejected", phrase, scope, variants };
  if (record.kind === "shadowed" || record.kind === "overridden") {
    return {
      kind: record.kind,
      phrase,
      scope,
      variants,
      tokenIds: decodeTokenIdArray(record.tokenIds, label),
      conflicts: decodeSamplingBiasConflictList(record.conflicts, label)
    };
  }
  if (record.kind !== "resolved") invalidField(label, "kind");
  return { kind: "resolved", phrase, scope, variants, tokenIds: decodeTokenIdArray(record.tokenIds, label) };
}

function decodeSamplingBiasScope(value: unknown, label: string): SamplingBiasScope {
  if (typeof value !== "string" || !(SAMPLING_BIAS_SCOPE_VALUES as readonly string[]).includes(value)) {
    invalidField(label, "scope");
  }
  return value as SamplingBiasScope;
}

function decodeTokenIdArray(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value) || value.some((id) => !Number.isSafeInteger(id) || id < 0)) {
    invalidField(label, "tokenIds");
  }
  return value as readonly number[];
}

function decodeSamplingBiasConflictList(
  value: unknown,
  label: string
): readonly { readonly tokenId: number; readonly owner: SamplingBiasShadowOwner }[] {
  if (!Array.isArray(value)) invalidField(label, "conflicts");
  return value.map((entry) => decodeSamplingBiasConflict(entry, `${label} conflict`));
}

function decodeSamplingBiasConflict(
  value: unknown,
  label: string
): { readonly tokenId: number; readonly owner: SamplingBiasShadowOwner } {
  const record = responseRecord(value, label);
  return {
    tokenId: nonNegativeIntegerField(record, "tokenId", label),
    owner: decodeShadowOwner(record.owner, label)
  };
}

function decodeShadowOwner(value: unknown, label: string): SamplingBiasShadowOwner {
  const record = responseRecord(value, `${label} owner`);
  const source = record.source;
  if (source === "logitBias") return { source };
  if (source !== "phraseBias" && source !== "bannedStrings") {
    invalidField(`${label} owner`, "source");
  }
  return {
    source,
    scope: decodeSamplingBiasScope(record.scope, `${label} owner`),
    phrase: stringField(record, "phrase", `${label} owner`)
  };
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

export function decodePromptTokenCount(value: unknown): PromptTokenCount {
  const response = responseRecord(value, "prompt token count");
  const kind = response.kind;
  if (kind === "estimate") {
    const reason = response.reason;
    if (!isMember(TOKEN_COUNT_FALLBACK_VALUES, reason)) {
      invalidField("prompt token count response", "reason");
    }
    return { kind: "estimate", reason };
  }
  if (kind !== "counted") invalidField("prompt token count response", "kind");
  const source = response.source;
  // `none` is not among them: a counted answer names the source that counted it.
  if (!isMember(COUNTED_TOKENIZE_SOURCE_VALUES, source)) {
    invalidField("prompt token count response", "source");
  }
  // A source is not free to claim any grade, nor a split it cannot produce.
  // Both are fixed by the source itself (shared/tokenize-source.ts), so a
  // response disagreeing with its own source is malformed, not a stronger
  // answer — accepting it would take the mark off a number that never earned
  // one.
  const contract = TOKENIZE_SOURCE_CONTRACTS[source];
  if (response.grade !== contract.grade) invalidField("prompt token count response", "grade");
  const perMessage = decodePerMessageTokenCounts(response.perMessage, "prompt token count response");
  if (!contract.perMessage && perMessage !== null) {
    invalidField("prompt token count response", "perMessage");
  }
  return {
    kind: "counted",
    source,
    // Taken from the contract, not the wire: the two were just proved equal,
    // and the contract is the side that decides.
    grade: contract.grade,
    total: nonNegativeIntegerField(response, "total", "prompt token count response"),
    perMessage
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

/** Re-serializes the decoded JSON and hands it to the same canonical parser
 * that verifies a stored object's bytes (shared/token-probabilities.ts), so
 * the client can never accept a shape the server itself would reject. */
export function decodeTokenProbabilitiesResponse(value: unknown): TokenProbabilityRecord {
  try {
    return parseTokenProbabilities(JSON.stringify(value));
  } catch (error) {
    throw new Error(
      `The server returned an invalid token probabilities response.${
        error instanceof Error ? ` ${error.message}` : ""
      }`
    );
  }
}

/** Mirrors `decodeTokenProbabilitiesResponse`: re-serializes the decoded JSON
 * and hands it to the same canonical parser that verifies a stored object's
 * bytes (shared/reasoning.ts). */
export function decodeReasoningResponse(value: unknown): ReasoningRecord {
  try {
    return parseReasoning(JSON.stringify(value));
  } catch (error) {
    throw new Error(
      `The server returned an invalid reasoning response.${
        error instanceof Error ? ` ${error.message}` : ""
      }`
    );
  }
}

const FACT_DROP_REASONS: ReadonlySet<string> = new Set(["priority", "fact-budget", "total-budget"]);

/** What generation admission actually shed to fit the fixed prompt — see
 *  server/generation-admission.ts. Empty on every response but a real
 *  continuation is expected and is not itself an error. */
function decodeFactBudgetDrops(value: unknown): FactBudgetDrop[] {
  if (!Array.isArray(value)) throw new Error("The server returned an invalid dropped-facts list.");
  return value.map((entry) => {
    const record = responseRecord(entry, "dropped fact");
    const factId = stringField(record, "factId", "dropped fact");
    const reason = record.reason;
    if (typeof reason !== "string" || !FACT_DROP_REASONS.has(reason)) {
      invalidField("dropped fact", "reason");
    }
    return { factId, reason: reason as FactBudgetDrop["reason"] };
  });
}

export function decodeContinueStoryResponse(
  value: unknown
): { payload: StoryPayload; droppedFacts: FactBudgetDrop[] } {
  const record = responseRecord(value, "continue-story result");
  return {
    payload: decodeStoryResponse(record.story),
    droppedFacts: decodeFactBudgetDrops(record.droppedFacts)
  };
}

/** The `rewrite-partial` route wraps the worker output so a null (nothing
 * stashed, or the bytes differ) is distinguishable from a transport error. */
export function decodeCommitPartialRewriteResponse(
  value: unknown
): { payload: StoryPayload; nodeId: string } | null {
  const envelope = responseRecord(value, "partial-rewrite commit");
  if (envelope.committed === null) return null;
  const record = responseRecord(
    envelope.committed,
    "partial-rewrite commit.committed"
  );
  const payload = record.payload;
  assertPromptReadyStoryPayload(payload);
  if (typeof record.nodeId !== "string") {
    throw new Error(
      "The server returned invalid partial-rewrite commit response.nodeId."
    );
  }
  return { payload, nodeId: record.nodeId };
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

/** Aligned one-to-one with the counted messages, or null when the source
 *  counts only a complete array. */
function decodePerMessageTokenCounts(value: unknown, label: string): readonly number[] | null {
  if (value === null) return null;
  if (
    !Array.isArray(value)
    || !value.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0)
  ) {
    invalidField(label, "perMessage");
  }
  return value as readonly number[];
}

/** Narrow a wire value against the shared list that declares it, so a decoder
 * never carries its own copy of a union that can grow without it. */
function isMember<T extends string>(values: readonly T[], candidate: unknown): candidate is T {
  return typeof candidate === "string" && (values as readonly string[]).includes(candidate);
}

function booleanField(value: Record<string, unknown>, field: string, label: string): boolean {
  const candidate = value[field];
  if (typeof candidate !== "boolean") invalidField(label, field);
  return candidate;
}

function invalidField(label: string, field: string): never {
  throw new Error(`The server returned invalid ${label}.${field}.`);
}
