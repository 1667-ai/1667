import type { HttpCapabilityScope } from "./http-auth.js";
import type { FailureEnvelope } from "./failure-envelope.js";
import type { HttpRecoveryWarning } from "./http-protocol.js";
import type { StoryAggregateVersion } from "./story-aggregate-version.js";
import type { WorkerMethod } from "./worker-protocol.js";

export const HTTP_OPERATION_SESSION_HEADER = "x-1667-operation-session";
export const HTTP_OPERATION_TICKET_HEADER = "x-1667-operation-ticket";
export const HTTP_OPERATION_MUTATION_ID_HEADER = "x-1667-mutation-id";

export const HTTP_OPERATION_SESSION_PATH = "/api/operations/sessions";
export const HTTP_OPERATION_RESERVATION_PATH = "/api/operations/reservations";
export const HTTP_OPERATION_CONTROL_PREFIX = "/api/operations/";

export const HTTP_OPERATION_START_DEADLINE_MS = 5_000;
export const HTTP_OPERATION_CANCEL_GRACE_MS = 2_000;
export const HTTP_OPERATION_TERMINAL_RETENTION_MS = 5 * 60_000;
export const HTTP_OPERATION_SESSION_IDLE_MS = 60_000;
export const HTTP_OPERATION_CAPACITY = 1_024;
export const HTTP_OPERATION_SESSION_CAPACITY = 64;
export const HTTP_OPERATION_SCOPE_SESSION_CAPACITY = 32;
export const HTTP_OPERATION_PER_SESSION_CAPACITY = 128;
export const HTTP_OPERATION_RESERVATION_LIMIT = 240;
export const HTTP_OPERATION_RESERVATION_WINDOW_MS = 60_000;
export const HTTP_OPERATION_SESSION_CREATION_LIMIT = 8;
export const HTTP_OPERATION_SESSION_CREATION_WINDOW_MS = 60_000;
export const HTTP_OPERATION_MAX_SEQUENCE = (1n << 64n) - 1n;

export type HttpOperationLifetime =
  | "control"
  | "local"
  | "transfer"
  | "provider-check"
  | "generation";

export const HTTP_OPERATION_LIFETIME_MS: Readonly<
  Record<HttpOperationLifetime, number>
> = Object.freeze({
  control: 5_000,
  local: 30_000,
  transfer: 120_000,
  "provider-check": 180_000,
  generation: 30 * 60_000
});

export type HttpOperationState =
  | "reserved"
  | "running"
  | "completed"
  | "canceled"
  | "failed";

export function isTerminalHttpOperationState(
  state: HttpOperationState
): boolean {
  return state === "completed" || state === "canceled" || state === "failed";
}

export interface HttpOperationSessionResponse {
  readonly listenerInstanceId: string;
  readonly sessionId: string;
  readonly scope: HttpCapabilityScope;
  readonly capability: string;
  readonly idleTimeoutMs: number;
}

export interface HttpOperationSessionEnvelope
  extends HttpOperationSessionResponse {
  readonly recoveryWarnings: HttpRecoveryWarning[];
}

export interface HttpOperationReservationRequest {
  readonly method: string;
  readonly path: string;
  readonly operation: WorkerMethod;
  readonly requestedLifetimeMs?: number;
  readonly mutationId?: string;
  readonly expectedAggregateVersion?: StoryAggregateVersion;
}

export interface HttpOperationReservationResponse {
  readonly listenerInstanceId: string;
  readonly sessionId: string;
  readonly sequence: string;
  readonly ticket: string;
  readonly lifetime: HttpOperationLifetime;
  readonly deadlineEpochMs: number;
  readonly startDeadlineEpochMs: number;
}

export interface HttpOperationStatusResponse {
  readonly listenerInstanceId: string;
  readonly sessionId: string;
  readonly sequence: string;
  readonly state: HttpOperationState;
  readonly terminal: boolean;
  readonly cancelRequested: boolean;
  readonly failure?: FailureEnvelope;
}
