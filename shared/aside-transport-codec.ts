/** Runtime codecs for the additive Aside transport boundary.
 *
 * Keep wire validation here. HTTP and Worker callers then share one set of
 * accepted request and response shapes instead of maintaining loose casts.
 */
import {
  assertPromptReadyStoryPayload,
  type StoryPayload
} from "./types.js";
import { AsideDocumentError } from "./aside-core.js";
import { assertAsideAnchor, type AsideAnchor } from "./aside-session.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";
import type {
  AsideAskInput,
  AsideAskRequest,
  AsideAskRequestValue,
  AsideAskResponse,
  AsideLegacyAskRequest,
  AsideLegacyReadResponse,
  AsidePresenceAnchorResponse,
  AsideReadRequest,
  AsideReadResponse,
  AsideResponseValue,
  AsideRetakeInput,
  AsideRetakeRequest,
  AsideSessionMutationInput,
  AsideSessionMutationRequest,
  AsideSessionMutationResponse,
  AsideSessionResponse,
  AsideSessionTurnResponse
} from "./aside-transport.js";

export class AsideTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsideTransportError";
  }
}

function invalid(label: string, detail: string): never {
  throw new AsideTransportError(`${label} ${detail}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(label, "must be an object.");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(label, "must be a string.");
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (result.length === 0) invalid(label, "must be a non-empty string.");
  return result;
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseSessionId(value: unknown): string {
  const sessionId = nonEmptyString(value, "Aside sessionId");
  if (hasUnpairedSurrogate(sessionId)) {
    invalid("Aside sessionId", "must be a well-formed Unicode string.");
  }
  if (sessionId.normalize("NFC") !== sessionId) {
    invalid("Aside sessionId", "must be NFC-normalized.");
  }
  if (unicodeScalarLength(sessionId, 129) > 128) {
    invalid("Aside sessionId", "must not exceed 128 Unicode scalars.");
  }
  return sessionId;
}

function parseTurnIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid("Aside turnIndex", "must be a non-negative integer.");
  }
  return value as number;
}

function parseAnchorValue(value: unknown, label: string): AsideAnchor | null {
  if (value === null) return null;
  const candidate = record(value, label);
  const anchor = {
    partId: nonEmptyString(candidate.partId, `${label}.partId`),
    takeId: nonEmptyString(candidate.takeId, `${label}.takeId`)
  } satisfies AsideAnchor;
  try {
    assertAsideAnchor(anchor);
  } catch (error) {
    if (error instanceof AsideDocumentError) invalid(label, `${error.message}.`);
    throw error;
  }
  return anchor;
}

export function parseAsideAnchor(
  value: unknown,
  label = "Aside anchor"
): AsideAnchor | null {
  return parseAnchorValue(value, label);
}

function parseRequiredAnchor(
  value: Record<string, unknown>,
  label: string
): AsideAnchor | null {
  if (!has(value, "anchor")) invalid(label, "must contain anchor.");
  return parseAnchorValue(value.anchor, `${label}.anchor`);
}

function parseStoryId(value: Record<string, unknown>, label: string): string {
  return nonEmptyString(value.storyId, `${label}.storyId`);
}

function parseTurn(value: unknown, index: number): AsideSessionTurnResponse {
  const entry = record(value, `Aside session turn ${index}`);
  const thoughts = has(entry, "thoughts")
    ? stringValue(entry.thoughts, `Aside session turn ${index}.thoughts`)
    : undefined;
  const thoughtTokens = has(entry, "thoughtTokens")
    ? entry.thoughtTokens
    : undefined;
  if (thoughtTokens !== undefined
    && (!Number.isSafeInteger(thoughtTokens) || (thoughtTokens as number) < 0)) {
    invalid(`Aside session turn ${index}.thoughtTokens`, "must be a non-negative integer.");
  }
  return {
    q: stringValue(entry.q, `Aside session turn ${index}.q`),
    a: stringValue(entry.a, `Aside session turn ${index}.a`),
    ...(thoughts === undefined ? {} : { thoughts }),
    ...(thoughtTokens === undefined ? {} : { thoughtTokens: thoughtTokens as number })
  };
}

function parseSessionCore(value: unknown): AsideSessionResponse {
  const entry = record(value, "Aside session response");
  if (entry.schemaVersion !== 2) invalid("Aside session response", "has an unsupported schemaVersion.");
  const id = nonEmptyString(entry.id, "Aside session response.id");
  const anchor = has(entry, "anchor")
    ? parseAnchorValue(entry.anchor, "Aside session response.anchor")
    : invalid("Aside session response", "must contain anchor.");
  const turnsValue = entry.turns;
  if (!Array.isArray(turnsValue)) invalid("Aside session response.turns", "must be an array.");
  return {
    schemaVersion: 2,
    id,
    anchor,
    title: stringValue(entry.title, "Aside session response.title"),
    turns: turnsValue.map(parseTurn)
  };
}

function parsePayload(value: unknown): StoryPayload {
  try {
    assertPromptReadyStoryPayload(value);
  } catch (error) {
    invalid(
      "Aside response.payload",
      error instanceof Error ? `${error.message}` : "is invalid."
    );
  }
  return value;
}

export function parseAsideLegacyReadResponse(value: unknown): AsideLegacyReadResponse {
  const entry = record(value, "Aside response");
  if (!Array.isArray(entry.notes)) invalid("Aside response.notes", "must be an array.");
  return {
    notes: entry.notes.map((note, index) => {
      const item = record(note, `Aside note ${index}`);
      return {
        question: stringValue(item.question, `Aside note ${index}.question`),
        answer: stringValue(item.answer, `Aside note ${index}.answer`)
      };
    })
  };
}

export function parseAsideSessionResponse(value: unknown): AsideSessionResponse {
  return parseSessionCore(value);
}

export function parseAsideAskResponse(value: unknown): AsideAskResponse {
  const session = parseSessionCore(value);
  const entry = record(value, "Aside ask response");
  if (!has(entry, "payload")) return session;
  return { ...session, payload: parsePayload(entry.payload) };
}

export function parseAsideSessionMutationResponse(
  value: unknown
): AsideSessionMutationResponse {
  const session = parseSessionCore(value);
  const entry = record(value, "Aside session mutation response");
  if (!has(entry, "payload")) return session;
  return { ...session, payload: parsePayload(entry.payload) };
}

function parsePresenceAnchor(value: unknown, index: number): AsidePresenceAnchorResponse {
  const entry = record(value, `Aside presence anchor ${index}`);
  const anchor = parseAnchorValue(entry, `Aside presence anchor ${index}`);
  if (anchor === null) invalid(`Aside presence anchor ${index}`, "must be anchored.");
  const sessionCount = entry.sessionCount;
  if (!Number.isSafeInteger(sessionCount) || (sessionCount as number) < 0) {
    invalid(`Aside presence anchor ${index}.sessionCount`, "must be a non-negative integer.");
  }
  const optionalCounts = ["partNumber", "takeIndex", "takeCount"] as const;
  const counts: {
    partNumber?: number;
    takeIndex?: number;
    takeCount?: number;
  } = {};
  for (const key of optionalCounts) {
    const count = entry[key];
    if (count === undefined) continue;
    if (!Number.isSafeInteger(count) || (count as number) < 1) {
      invalid(`Aside presence anchor ${index}.${key}`, "must be a positive integer.");
    }
    counts[key] = count as number;
  }
  return { ...anchor, sessionCount: sessionCount as number, ...counts };
}

export function parseAsideReadResponse(value: unknown): AsideReadResponse {
  const entry = record(value, "Aside v2 read response");
  if (entry.schemaVersion !== 2) invalid("Aside v2 read response", "has an unsupported schemaVersion.");
  const anchor = has(entry, "anchor")
    ? parseAnchorValue(entry.anchor, "Aside v2 read response.anchor")
    : invalid("Aside v2 read response", "must contain anchor.");
  if (!Array.isArray(entry.sessions)) invalid("Aside v2 read response.sessions", "must be an array.");
  if (!Array.isArray(entry.anchors)) invalid("Aside v2 read response.anchors", "must be an array.");
  const unanchoredCount = entry.unanchoredCount;
  if (!Number.isSafeInteger(unanchoredCount) || (unanchoredCount as number) < 0) {
    invalid("Aside v2 read response.unanchoredCount", "must be a non-negative integer.");
  }
  return {
    schemaVersion: 2,
    anchor,
    sessions: entry.sessions.map(parseSessionCore),
    anchors: entry.anchors.map(parsePresenceAnchor),
    unanchoredCount: unanchoredCount as number
  };
}

/** Parse the v1/v2 response union used by the Worker `getAside` method. */
export function parseAsideResponse(value: unknown): AsideResponseValue {
  const entry = record(value, "Aside response");
  if (Array.isArray(entry.notes)) return parseAsideLegacyReadResponse(value);
  if (entry.schemaVersion !== 2) invalid("Aside response", "is not a supported v1 or v2 response.");
  return Array.isArray(entry.sessions)
    ? parseAsideReadResponse(value)
    : parseAsideSessionResponse(value);
}

export function parseAsideReadRequest(value: unknown): AsideReadRequest {
  const entry = record(value, "Aside read request");
  const storyId = parseStoryId(entry, "Aside read request");
  if (!has(entry, "anchor")) return { storyId };
  return { storyId, anchor: parseAnchorValue(entry.anchor, "Aside read request.anchor") };
}

export function parseAsideAskRequestValue(value: unknown): AsideAskRequestValue {
  const entry = record(value, "Aside ask request");
  const storyId = parseStoryId(entry, "Aside ask request");
  const question = nonEmptyString(entry.question, "Aside ask request.question");
  const hasAnchor = has(entry, "anchor");
  const hasSession = has(entry, "sessionId");
  if (!hasAnchor && !hasSession) return { storyId, question } satisfies AsideLegacyAskRequest;
  if (!hasAnchor) invalid("Aside ask request", "must contain anchor for a v2 session ask.");
  const anchor = parseAnchorValue(entry.anchor, "Aside ask request.anchor");
  const sessionId = hasSession ? parseSessionId(entry.sessionId) : undefined;
  return {
    storyId,
    question,
    anchor,
    ...(sessionId === undefined ? {} : { sessionId })
  } satisfies AsideAskRequest;
}

export function parseAsideAskRequest(value: unknown): AsideAskRequest {
  const parsed = parseAsideAskRequestValue(value);
  if (!("anchor" in parsed)) invalid("Aside ask request", "is a legacy request, not a v2 request.");
  return parsed;
}

export function parseAsideAskBody(
  storyId: string,
  value: unknown
): AsideAskRequestValue {
  const body = record(value, "Aside ask body");
  return parseAsideAskRequestValue({ ...body, storyId });
}

export function asideAskInput(request: AsideAskRequest): AsideAskInput {
  const { storyId: _storyId, ...input } = request;
  return input;
}

export function parseAsideSessionMutationRequest(
  value: unknown
): AsideSessionMutationRequest {
  const entry = record(value, "Aside session mutation request");
  const storyId = parseStoryId(entry, "Aside session mutation request");
  const operation = entry.operation;
  if (operation !== "delete-turn" && operation !== "reset" && operation !== "clear") {
    invalid("Aside session mutation request.operation", "is invalid.");
  }
  const sessionId = parseSessionId(entry.sessionId);
  const anchor = parseRequiredAnchor(entry, "Aside session mutation request");
  if (operation === "clear") return { storyId, operation, sessionId, anchor };
  return {
    storyId,
    operation,
    sessionId,
    anchor,
    turnIndex: parseTurnIndex(entry.turnIndex)
  };
}

export function asideSessionMutationInput(
  request: AsideSessionMutationRequest
): AsideSessionMutationInput {
  const { storyId: _storyId, ...input } = request;
  return input;
}

export function parseAsideSessionMutationBody(
  storyId: string,
  value: unknown
): AsideSessionMutationRequest {
  const body = record(value, "Aside session mutation body");
  return parseAsideSessionMutationRequest({ ...body, storyId });
}

export function parseAsideRetakeRequest(value: unknown): AsideRetakeRequest {
  const entry = record(value, "Aside retake request");
  const storyId = parseStoryId(entry, "Aside retake request");
  const sessionId = parseSessionId(entry.sessionId);
  const anchor = parseRequiredAnchor(entry, "Aside retake request");
  return {
    storyId,
    sessionId,
    anchor,
    turnIndex: parseTurnIndex(entry.turnIndex)
  };
}

export function asideRetakeInput(request: AsideRetakeRequest): AsideRetakeInput {
  const { storyId: _storyId, ...input } = request;
  return input;
}

export function parseAsideRetakeBody(
  storyId: string,
  value: unknown
): AsideRetakeRequest {
  const body = record(value, "Aside retake body");
  return parseAsideRetakeRequest({ ...body, storyId });
}
