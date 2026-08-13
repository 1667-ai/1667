import type { HttpCapabilityScope } from "../shared/http-auth.js";
import {
  HTTP_OPERATION_LIFETIME_MS,
  HTTP_OPERATION_START_DEADLINE_MS,
  type HttpOperationReservationRequest
} from "../shared/http-operation-protocol.js";
import { resolveHttpApiRoute } from "../shared/http-operation-policy.js";
import type { HttpSupervisedOperationDescriptor } from "../shared/supervised-serve-protocol.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import { ServiceError } from "./errors.js";
import {
  canonicalHttpOperationMethod,
  canonicalHttpOperationPath,
  requestedHttpOperationLifetime,
  requireHttpOperationExpectedStoryVersion,
  requireHttpOperationMutationId,
  type HttpOperationRecord
} from "./http-operation-session-state.js";

export interface ResolvedHttpOperationReservation {
  readonly method: string;
  readonly path: string;
  readonly operation: HttpSupervisedOperationDescriptor["operation"];
  readonly mutationId: string | null;
  readonly expectedAggregateVersion: StoryAggregateVersion | null;
  readonly lifetime: HttpSupervisedOperationDescriptor["lifetime"];
  readonly lifetimeMs: number;
}

export function resolveHttpOperationReservation(
  request: HttpOperationReservationRequest,
  scope: HttpCapabilityScope
): ResolvedHttpOperationReservation {
  const method = canonicalHttpOperationMethod(request.method);
  const path = canonicalHttpOperationPath(request.path);
  if (path.startsWith("/api/operations/")) {
    throw new ServiceError(
      400,
      "HTTP operation control requests are not reservable",
      "invalid_request"
    );
  }
  let policy: ReturnType<typeof resolveHttpApiRoute>;
  try {
    policy = resolveHttpApiRoute(method, path);
  } catch {
    throw new ServiceError(
      400,
      "HTTP operation has no registered command policy",
      "invalid_request"
    );
  }
  if (policy.scope !== scope) {
    throw new ServiceError(
      403,
      "HTTP operation path exceeds the session scope",
      "forbidden"
    );
  }
  if (request.operation !== policy.method) {
    throw new ServiceError(
      409,
      "HTTP operation command does not match its route",
      "invalid_request"
    );
  }
  const mutationId = requireHttpOperationMutationId(
    request.mutationId,
    policy.method
  );
  const expectedAggregateVersion = requireHttpOperationExpectedStoryVersion(
    request.expectedAggregateVersion,
    scope,
    policy.method
  );
  const requested = requestedHttpOperationLifetime(
    request.requestedLifetimeMs
  );
  if (requested !== null
    && requested <= 10_000
    && (policy.lifetime === "provider-check"
      || policy.lifetime === "generation")) {
    throw new ServiceError(
      400,
      "Provider operation deadlines must exceed the 10-second commit allowance",
      "invalid_request"
    );
  }
  return {
    method,
    path,
    operation: policy.method,
    mutationId,
    expectedAggregateVersion,
    lifetime: policy.lifetime,
    lifetimeMs: Math.min(
      requested ?? HTTP_OPERATION_LIFETIME_MS[policy.lifetime],
      HTTP_OPERATION_LIFETIME_MS[policy.lifetime]
    )
  };
}

export function createHttpOperationRecord(
  reservation: ResolvedHttpOperationReservation,
  sessionId: string,
  sequence: bigint,
  scope: HttpCapabilityScope,
  ticket: string,
  now: number,
  epochNow: number
): HttpOperationRecord {
  const startDelay = Math.min(
    HTTP_OPERATION_START_DEADLINE_MS,
    reservation.lifetimeMs
  );
  return {
    sessionId,
    sequence,
    scope,
    ticket,
    method: reservation.method,
    path: reservation.path,
    operation: reservation.operation,
    mutationId: reservation.mutationId,
    expectedAggregateVersion: reservation.expectedAggregateVersion,
    lifetime: reservation.lifetime,
    lifetimeMs: reservation.lifetimeMs,
    deadline: now + reservation.lifetimeMs,
    deadlineEpochMs: epochNow + reservation.lifetimeMs,
    startDeadline: now + startDelay,
    startDeadlineEpochMs: epochNow + startDelay,
    abort: new AbortController(),
    state: "reserved",
    cancelRequested: false,
    cancellationSource: null,
    failure: null,
    terminalAt: null,
    timer: null,
    hardTimer: null
  };
}
