/**
 * Durable v2 session mutation preparation.
 *
 * This module validates a target against the live session ref, reads the
 * content-addressed document, and applies one pure shared transform. The
 * caller owns the receipt transaction and publishes the pending object.
 */
import {
  AsideDocumentError,
  deleteAsideTurn,
  assertAsideAnchor,
  migrateAsideDocumentToUnanchored,
  resetAsideSession,
  type AsideAnchor,
  type AsideSessionDocument
} from "../shared/aside.js";
import type {
  AsideSessionMutationInput,
  AsideSessionMutationOperation
} from "../shared/aside-transport.js";
import { applyProviderStoryEffect } from "./story-provider-effect.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import type { Story } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import {
  asideSessionRefById,
  effectiveAsideSessionAnchor,
  legacyAsideDocumentIdForSession,
  sameAsideAnchor
} from "./aside-session-store.js";
import { viewAsideSessionDocument, type AsideSessionView } from "./aside-session-http.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";

export interface ParsedAsideSessionMutation {
  readonly operation: AsideSessionMutationOperation;
  readonly sessionId: string;
  readonly anchor: AsideAnchor | null;
  readonly turnIndex: number | null;
}

export interface PreparedAsideSessionMutation {
  readonly target: ParsedAsideSessionMutation;
  readonly expected: AsideSessionDocument;
  readonly replacement: AsideSessionDocument;
  readonly expectedDocumentId: string | null;
  readonly expectedLegacyDocumentId: string | null;
  readonly expectedAnchor: AsideAnchor | null;
}

export function parseAsideSessionMutation(
  body: AsideSessionMutationInput
): ParsedAsideSessionMutation {
  const operation = body.operation;
  if (operation !== "delete-turn" && operation !== "reset" && operation !== "clear") {
    throw new ServiceError(400, "Aside session operation is invalid.", "invalid_request");
  }
  const sessionId = body.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0
    || hasUnpairedSurrogate(sessionId)
    || sessionId.normalize("NFC") !== sessionId
    || unicodeScalarLength(sessionId, 129) > 128) {
    throw new ServiceError(
      400,
      "sessionId must be a non-empty, well-formed NFC-normalized string",
      "invalid_request"
    );
  }
  const anchor = parseAnchor(body.anchor);
  if (operation === "clear") {
    return { operation, sessionId, anchor, turnIndex: null };
  }
  const turnIndex = "turnIndex" in body ? body.turnIndex : undefined;
  if (!Number.isSafeInteger(turnIndex) || (turnIndex as number) < 0) {
    throw new ServiceError(
      400,
      "turnIndex must be a non-negative integer",
      "invalid_request"
    );
  }
  return { operation, sessionId, anchor, turnIndex: turnIndex as number };
}

export async function prepareAsideSessionMutation(
  story: Story,
  session: StoryAggregateSession,
  target: ParsedAsideSessionMutation
): Promise<PreparedAsideSessionMutation> {
  const ref = asideSessionRefById(story, target.sessionId);
  const legacyDocumentId = ref === null
    ? legacyAsideDocumentIdForSession(story, target.sessionId)
    : null;
  let expected: AsideSessionDocument | null = null;
  if (ref !== null) {
    expected = await session.readAsideSessionDocument(ref.documentId);
  } else if (legacyDocumentId !== null) {
    expected = migrateAsideDocumentToUnanchored(
      await session.readAsideDocument(legacyDocumentId)
    );
  }
  if (expected === null) {
    throw new ServiceError(404, "Aside session was not found.", "not_found");
  }
  const expectedAnchor = ref === null
    ? null
    : effectiveAsideSessionAnchor(story, ref, expected.anchor);
  if (!sameAsideAnchor(expectedAnchor, target.anchor)) {
    throw new ServiceError(
      409,
      "This Aside session is anchored to a different take.",
      "conflict"
    );
  }

  let replacement: AsideSessionDocument;
  try {
    if (target.operation === "delete-turn") {
      replacement = deleteAsideTurn(expected, target.turnIndex!);
    } else if (target.operation === "reset") {
      replacement = resetAsideSession(expected, target.turnIndex!);
    } else {
      replacement = {
        schemaVersion: expected.schemaVersion,
        anchor: expected.anchor === null ? null : { ...expected.anchor },
        title: expected.title,
        turns: []
      };
    }
  } catch (error) {
    if (error instanceof AsideDocumentError) {
      throw new ServiceError(409, error.message, "conflict");
    }
    throw error;
  }
  return {
    target,
    expected,
    replacement,
    expectedDocumentId: ref?.documentId ?? null,
    expectedLegacyDocumentId: legacyDocumentId,
    expectedAnchor
  };
}

export async function applyPreparedAsideSessionMutation(
  story: Story,
  session: StoryAggregateSession,
  prepared: PreparedAsideSessionMutation
): Promise<AsideSessionView> {
  const materializesLegacy = prepared.expectedDocumentId === null
    && prepared.expectedLegacyDocumentId !== null;
  const effect = {
    kind: "aside",
    expectedAsideSessionDocumentId: prepared.expectedDocumentId,
    expectedAsideSessionAnchor: prepared.expectedAnchor,
    sessionId: prepared.target.sessionId,
    sessionDocument: prepared.replacement
  } as const;
  if (materializesLegacy) {
    await applyProviderStoryEffect(story, {
      ...effect,
      expectedAsideDocumentId: prepared.expectedLegacyDocumentId,
      materializesLegacy: true
    }, async (current, nodeId) => await session.hydratePath(current, nodeId));
  } else {
    await applyProviderStoryEffect(
      story,
      effect,
      async (current, nodeId) => await session.hydratePath(current, nodeId)
    );
  }
  return viewAsideSessionDocument(
    prepared.replacement,
    prepared.target.sessionId,
    prepared.expectedAnchor
  )!;
}

function parseAnchor(value: unknown): AsideAnchor | null {
  if (value === null) return null;
  if (value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(
      400,
      "anchor must contain partId and takeId",
      "invalid_request"
    );
  }
  const anchor = value as Record<string, unknown>;
  if (typeof anchor.partId !== "string" || typeof anchor.takeId !== "string") {
    throw new ServiceError(
      400,
      "anchor must contain partId and takeId",
      "invalid_request"
    );
  }
  try {
    assertAsideAnchor({ partId: anchor.partId, takeId: anchor.takeId });
  } catch (error) {
    throw new ServiceError(
      400,
      error instanceof Error ? error.message : "anchor is invalid",
      "invalid_request"
    );
  }
  return { partId: anchor.partId, takeId: anchor.takeId };
}
