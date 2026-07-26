import {
  isDiagnosticReference,
  type DiagnosticReference
} from "./diagnostic-reference.js";

export const MAX_FAILURE_CODE_LENGTH = 128;
export const MAX_FAILURE_MESSAGE_LENGTH = 4_096;

const FAILURE_CODE_VALUES = [
  "invalid_request",
  "invalid_response",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "content_too_large",
  "unprocessable",
  "provider_failure",
  "resource_busy",
  "startup_failure",
  "story_manifest_requires_successor",
  "idempotency_conflict",
  "revision_conflict",
  "receipt_storage_unavailable",
  "data_directory_unowned",
  "data_directory_version_unsupported",
  "settings_edit_requires_data_format_2",
  "credential_test_requires_activation",
  "mutation_expired",
  "mutation_outcome_unknown",
  "generation_outcome_unknown",
  "generation_outcome_unknown_acknowledged",
  "catalog_cursor_expired",
  "operation_unknown",
  "operation_expired",
  "operation_session_terminal",
  "internal"
] as const;

export type FailureCode = typeof FAILURE_CODE_VALUES[number];

const FAILURE_CODES: ReadonlySet<string> = new Set(FAILURE_CODE_VALUES);

export interface PlainFailureEnvelope {
  readonly kind: "plain";
  readonly code: FailureCode;
  readonly message: string;
  readonly status: number | null;
}

export interface DiagnosticFailureEnvelope {
  readonly kind: "diagnostic";
  readonly code: FailureCode;
  readonly message: string;
  readonly status: number | null;
  readonly diagnosticRef: DiagnosticReference;
}

/** Canonical public failure plus optional, valid-by-construction diagnostic. */
export type FailureEnvelope =
  | PlainFailureEnvelope
  | DiagnosticFailureEnvelope;

export type CompatibleHttpFailureEnvelope =
  | {
      readonly kind: "plain";
      readonly code: string;
      readonly message: string;
      readonly status: number | null;
    }
  | {
      readonly kind: "diagnostic";
      readonly code: string;
      readonly message: string;
      readonly status: number | null;
      readonly diagnosticRef: DiagnosticReference;
    };

export interface FailureWireFields {
  readonly code: FailureCode;
  readonly message: string;
  readonly status: number | null;
  readonly diagnosticRef?: DiagnosticReference;
}

export interface HttpFailurePayload {
  readonly error: string;
  readonly code: FailureCode;
  readonly diagnosticRef?: DiagnosticReference;
}

export interface FailureMessageFields {
  readonly message: string;
  readonly diagnosticRef?: DiagnosticReference;
}

export function createFailureEnvelope(
  failure: {
    readonly code: unknown;
    readonly message: unknown;
    readonly status: unknown;
  }
): PlainFailureEnvelope;
export function createFailureEnvelope(
  failure: {
    readonly code: unknown;
    readonly message: unknown;
    readonly status: unknown;
  },
  diagnosticRef: unknown
): FailureEnvelope;
export function createFailureEnvelope(
  failure: {
    readonly code: unknown;
    readonly message: unknown;
    readonly status: unknown;
  },
  diagnosticRef?: unknown
): FailureEnvelope {
  const validCode = isFailureCode(failure.code);
  const message = boundedFailureMessage(failure.message);
  const validFailure = validCode
    && message !== null
    && isFailureStatus(failure.status);
  const code: FailureCode = validFailure ? failure.code : "internal";
  const publicMessage = validFailure && code !== "internal"
    ? message
    : "Internal server error";
  const status = validFailure ? failure.status : 500;
  return Object.freeze(isDiagnosticReference(diagnosticRef)
    ? {
        kind: "diagnostic",
        code,
        message: publicMessage,
        status,
        diagnosticRef
      }
    : {
        kind: "plain",
        code,
        message: publicMessage,
        status
      });
}

/** Decode the flat error bodies shared by ordinary HTTP responses and SSE
 * error events into the same bounded canonical envelope. */
export function decodeHttpFailurePayload(
  value: unknown,
  fallbackMessage: string,
  status: unknown,
  fallbackStatus = 500
): CompatibleHttpFailureEnvelope {
  const payload = value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const message = nonemptyString(payload.error)
    ? payload.error
    : nonemptyString(payload.message)
      ? payload.message
      : fallbackMessage;
  const code = isBoundedFailureCode(payload.code)
    ? payload.code
    : null;
  const httpStatus = isHttpStatus(status)
    ? status
    : fallbackStatus;
  if (code === null) {
    return createFailureEnvelope(
      {
        code: "invalid_response",
        message: fallbackMessage,
        status: httpStatus
      },
      payload.diagnosticRef
    );
  }
  return createCompatibleHttpFailureEnvelope(
    { code, message, status: httpStatus },
    payload.diagnosticRef
  );
}

export function isFailureEnvelope(value: unknown): value is FailureEnvelope {
  if (value === null || typeof value !== "object") return false;
  const failure = value as Partial<FailureEnvelope>;
  if (!isFailureCode(failure.code)
    || !validFailureString(failure.message, MAX_FAILURE_MESSAGE_LENGTH)
    || !isFailureStatus(failure.status)
    || (failure.code === "internal"
      && failure.message !== "Internal server error")) {
    return false;
  }
  if (failure.kind === "plain") {
    return hasExactKeys(value, ["kind", "code", "message", "status"]);
  }
  return failure.kind === "diagnostic"
    && isDiagnosticReference(failure.diagnosticRef)
    && hasExactKeys(
      value,
      ["kind", "code", "message", "status", "diagnosticRef"]
    );
}

export function diagnosticReferenceFromFailure(
  failure: CompatibleHttpFailureEnvelope
): DiagnosticReference | null {
  return failure.kind === "diagnostic" ? failure.diagnosticRef : null;
}

/** Canonical flat projection for SSE and additive protocol metadata. */
export function failureWireFields(
  failure: FailureEnvelope
): FailureWireFields {
  return {
    code: failure.code,
    message: failure.message,
    status: failure.status,
    ...diagnosticWireField(failure)
  };
}

/** Backwards-compatible ordinary HTTP error body. */
export function httpFailurePayload(
  failure: FailureEnvelope
): HttpFailurePayload {
  return {
    error: failure.message,
    code: failure.code,
    ...diagnosticWireField(failure)
  };
}

/** Backwards-compatible process-boundary failure fields. */
export function failureMessageFields(
  failure: FailureEnvelope
): FailureMessageFields {
  return {
    message: failure.message,
    ...diagnosticWireField(failure)
  };
}

/** Reads canonical envelopes and pre-envelope flat durable/wire records. */
export function decodeFailureEnvelope(
  value: unknown
): FailureEnvelope | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const tagged = "kind" in raw;
  if (tagged
    && raw.kind !== "plain"
    && raw.kind !== "diagnostic") {
    return null;
  }
  const expectedKeys = raw.kind === "diagnostic"
    ? ["kind", "code", "message", "status", "diagnosticRef"]
    : raw.kind === "plain"
      ? ["kind", "code", "message", "status"]
      : raw.diagnosticRef === undefined
        ? ["code", "message", "status"]
        : ["code", "message", "status", "diagnosticRef"];
  if (!hasExactKeys(raw, expectedKeys)) return null;
  if (!validFailureString(raw.code, MAX_FAILURE_CODE_LENGTH)
    || !nonemptyString(raw.message)
    || !isFailureStatus(raw.status)) return null;
  if (tagged
    && !validFailureString(raw.message, MAX_FAILURE_MESSAGE_LENGTH)) {
    return null;
  }
  if (raw.kind === "plain" && "diagnosticRef" in raw) return null;
  if (raw.kind === "diagnostic"
    && !isDiagnosticReference(raw.diagnosticRef)) return null;
  const decoded = createFailureEnvelope({
    code: raw.code,
    message: raw.message,
    status: raw.status
  }, raw.diagnosticRef);
  if (raw.diagnosticRef !== undefined && decoded.kind !== "diagnostic") {
    return null;
  }
  return decoded;
}

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && FAILURE_CODES.has(value);
}

export function isBoundedFailureCode(value: unknown): value is string {
  return validFailureString(value, MAX_FAILURE_CODE_LENGTH);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasExactKeys(
  value: object,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key));
}

function diagnosticWireField(
  failure: FailureEnvelope
): { readonly diagnosticRef?: DiagnosticReference } {
  return failure.kind === "diagnostic"
    ? { diagnosticRef: failure.diagnosticRef }
    : {};
}

function isFailureStatus(value: unknown): value is number | null {
  return value === null
    || (
      Number.isSafeInteger(value)
      && (value as number) >= 100
      && (value as number) <= 599
    );
}

function isHttpStatus(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 100
    && (value as number) <= 599;
}

function validFailureString(
  value: unknown,
  maximumLength: number
): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength;
}

function boundedFailureMessage(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length <= MAX_FAILURE_MESSAGE_LENGTH) return value;
  const prefix = value.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
  return /[\uD800-\uDBFF]$/.test(prefix)
    ? prefix.slice(0, -1)
    : prefix;
}

export function createCompatibleHttpFailureEnvelope(
  failure: {
    readonly code: unknown;
    readonly message: unknown;
    readonly status: unknown;
  },
  diagnosticRef: unknown
): CompatibleHttpFailureEnvelope {
  const code = isBoundedFailureCode(failure.code)
    ? failure.code
    : "invalid_response";
  const message = boundedFailureMessage(failure.message)
    ?? "Internal server error";
  const publicMessage = code === "internal"
    ? "Internal server error"
    : message;
  const status = isFailureStatus(failure.status)
    ? failure.status
    : 500;
  return Object.freeze(isDiagnosticReference(diagnosticRef)
    ? {
        kind: "diagnostic",
        code,
        message: publicMessage,
        status,
        diagnosticRef
      }
    : {
        kind: "plain",
        code,
        message: publicMessage,
        status
      });
}
