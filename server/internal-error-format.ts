import type { DiagnosticReference } from "../shared/diagnostic-reference.js";
import { ProviderError } from "./errors.js";

const MAX_DIAGNOSTIC_TEXT = 16_384;
const MAX_CONTEXT_TEXT = 4_096;
const MAX_CAUSE_DEPTH = 4;
const MAX_AGGREGATE_ERRORS = 8;
const MAX_ERROR_GRAPH_NODES = 32;

export interface InternalErrorContext {
  readonly service: string;
  readonly operation?: string;
  readonly workerOperationId?: string;
}

/** Pure, bounded diagnostic serialization. Provider response-bearing errors
 * receive a typed redaction before any message or stack is inspected. */
export function formatInternalErrorDiagnostic(
  error: unknown,
  context: InternalErrorContext,
  reference: DiagnosticReference,
  timestamp: string,
  maximumBytes: number
): string {
  const safeContext = boundedContext(context);
  const line = `${JSON.stringify({
    timestamp,
    level: "error",
    ref: reference,
    service: safeContext.service,
    ...(safeContext.operation === undefined
      ? {}
      : { operation: safeContext.operation }),
    ...(safeContext.workerOperationId === undefined
      ? {}
      : { workerOperationId: safeContext.workerOperationId }),
    error: diagnosticError(error)
  })}\n`;
  if (utf8ByteLength(line) <= maximumBytes) return line;
  return `${JSON.stringify({
    timestamp,
    level: "error",
    ref: reference,
    service: safeContext.service,
    ...(safeContext.operation === undefined
      ? {}
      : { operation: safeContext.operation }),
    ...(safeContext.workerOperationId === undefined
      ? {}
      : { workerOperationId: safeContext.workerOperationId }),
    error: {
      name: "TruncatedDiagnostic",
      message: "Diagnostic exceeded the bounded log-entry size",
      serializedBytes: utf8ByteLength(line)
    }
  })}\n`;
}

export function formatInternalErrorFallback(
  reference: DiagnosticReference,
  message: string,
  error: unknown,
  timestamp: string
): string {
  try {
    return `${JSON.stringify({
      timestamp,
      level: "error",
      ref: reference,
      service: "internal-error-log",
      message,
      error: diagnosticError(error)
    })}\n`;
  } catch {
    return `{"level":"error","ref":"${reference}","service":"internal-error-log","message":"log write failed"}\n`;
  }
}

export function formatInternalErrorEmergency(
  error: unknown,
  formatError: unknown,
  timestamp: string
): string {
  try {
    return `${JSON.stringify({
      timestamp,
      level: "error",
      service: "internal-error-log",
      message: "diagnostic formatting failed",
      originalError: emergencyErrorDescription(error),
      formattingError: bounded(safeString(formatError))
    })}\n`;
  } catch {
    return "{\"level\":\"error\",\"service\":\"internal-error-log\",\"message\":\"diagnostic formatting failed\"}\n";
  }
}

function emergencyErrorDescription(error: unknown): string {
  return safeInstanceOfProviderError(error)
    ? "ProviderError (details redacted)"
    : bounded(safeString(error));
}

function boundedContext(
  context: InternalErrorContext
): InternalErrorContext {
  const service = boundedContextProperty(context, "service") ?? "<unavailable>";
  const operation = boundedContextProperty(context, "operation");
  const workerOperationId = boundedContextProperty(
    context,
    "workerOperationId"
  );
  return {
    service,
    ...(operation === undefined ? {} : { operation }),
    ...(workerOperationId === undefined ? {} : { workerOperationId })
  };
}

function boundedContextProperty(
  context: InternalErrorContext,
  property: keyof InternalErrorContext
): string | undefined {
  try {
    const value = context[property];
    return value === undefined
      ? undefined
      : safeString(value).slice(0, MAX_CONTEXT_TEXT);
  } catch {
    return undefined;
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

interface ErrorTraversal {
  readonly seen: Set<object>;
  remaining: number;
}

function diagnosticError(
  error: unknown,
  depth = 0,
  traversal: ErrorTraversal = {
    seen: new Set<object>(),
    remaining: MAX_ERROR_GRAPH_NODES
  }
): Record<string, unknown> {
  if (traversal.remaining <= 0) {
    return {
      name: "TruncatedErrorGraph",
      message: "Error graph limit reached"
    };
  }
  traversal.remaining -= 1;
  if (safeInstanceOfProviderError(error)) {
    return redactedProviderError(error);
  }
  if (!safeInstanceOfError(error)) {
    return { name: typeof error, message: bounded(safeString(error)) };
  }
  if (traversal.seen.has(error)) {
    return {
      name: "CircularErrorReference",
      message: "Error already serialized"
    };
  }
  traversal.seen.add(error);
  const name = readErrorProperty(error, "name");
  const message = readErrorProperty(error, "message");
  const stack = readErrorProperty(error, "stack");
  const cause = readErrorProperty(error, "cause");
  const aggregateErrors = readAggregateErrors(error);
  return {
    name: bounded(safeString(name ?? "Error")),
    message: bounded(safeString(message ?? "<unavailable>")),
    ...(stack === undefined ? {} : { stack: bounded(safeString(stack)) }),
    ...(aggregateErrors === null || depth >= MAX_CAUSE_DEPTH
      ? {}
      : {
          errors: aggregateErrors.map((entry) =>
            diagnosticError(entry, depth + 1, traversal))
        }),
    ...(cause === undefined || depth >= MAX_CAUSE_DEPTH
      ? {}
      : { cause: diagnosticError(cause, depth + 1, traversal) })
  };
}

function redactedProviderError(error: ProviderError): Record<string, unknown> {
  const status = readProviderStatus(error);
  return {
    name: "ProviderError",
    message: status === null
      ? "Provider request failed"
      : `Provider request failed with HTTP status ${status}`,
    ...(status === null ? {} : { status })
  };
}

function readProviderStatus(error: ProviderError): number | null {
  try {
    return Number.isSafeInteger(error.status)
      && error.status! >= 100
      && error.status! <= 599
      ? error.status
      : null;
  } catch {
    return null;
  }
}

function readAggregateErrors(error: Error): unknown[] | null {
  try {
    if (!(error instanceof AggregateError)) return null;
    const errors = error.errors;
    if (!Array.isArray(errors)) return null;
    const result: unknown[] = [];
    for (
      let index = 0;
      index < Math.min(errors.length, MAX_AGGREGATE_ERRORS);
      index += 1
    ) {
      try {
        result.push(errors[index]);
      } catch {
        result.push("<unavailable>");
      }
    }
    return result;
  } catch {
    return null;
  }
}

function bounded(value: string): string {
  return value.slice(0, MAX_DIAGNOSTIC_TEXT);
}

function safeInstanceOfProviderError(
  value: unknown
): value is ProviderError {
  try {
    return value instanceof ProviderError;
  } catch {
    return false;
  }
}

function safeInstanceOfError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function readErrorProperty(
  error: Error,
  property: "name" | "message" | "stack" | "cause"
): unknown {
  try {
    return error[property];
  } catch {
    return undefined;
  }
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "<unavailable>";
  }
}
