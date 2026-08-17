import type { DiagnosticReference } from "../shared/diagnostic-reference.js";
import { sliceWellFormedUtf16Prefix } from "../shared/unicode.js";
import { ProviderError } from "./errors.js";

const MAX_DIAGNOSTIC_TEXT = 16_384;
const MAX_CONTEXT_TEXT = 4_096;
const MAX_CAUSE_DEPTH = 4;
const MAX_AGGREGATE_ERRORS = 8;
const MAX_ERROR_GRAPH_NODES = 32;
const MAX_PUBLIC_DIAGNOSTIC_TEXT = 1_024;
const MAX_PUBLIC_CAUSE_DEPTH = 3;
const MAX_PUBLIC_AGGREGATE_ERRORS = 3;
const MAX_PUBLIC_ERROR_GRAPH_NODES = 16;

export interface InternalErrorContext {
  readonly service: string;
  readonly operation?: string;
  readonly workerOperationId?: string;
}

/** Return a short, single-line diagnostic for the local process boundary.
 * The private serializer remains the source of truth for safe error access
 * and provider redaction. Stacks and provider bodies never enter this text. */
export function formatInternalErrorMessage(error: unknown): string {
  const diagnostic = diagnosticError(error, PUBLIC_DIAGNOSTIC_POLICY);
  const message = formatPublicDiagnostic(diagnostic ?? {
    name: "Error",
    message: "<unavailable>"
  });
  return message.length <= MAX_PUBLIC_DIAGNOSTIC_TEXT
    ? message
    : `${sliceWellFormedUtf16Prefix(
        message,
        MAX_PUBLIC_DIAGNOSTIC_TEXT - 1
      ).trimEnd()}…`;
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

interface DiagnosticTraversalPolicy {
  readonly causeFirst: boolean;
  readonly includeStack: boolean;
  readonly maxAggregateErrors: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly omitRepeatedReferences: boolean;
}

const PRIVATE_DIAGNOSTIC_POLICY: DiagnosticTraversalPolicy = Object.freeze({
  causeFirst: false,
  includeStack: true,
  maxAggregateErrors: MAX_AGGREGATE_ERRORS,
  maxDepth: MAX_CAUSE_DEPTH,
  maxNodes: MAX_ERROR_GRAPH_NODES,
  omitRepeatedReferences: false
});

const PUBLIC_DIAGNOSTIC_POLICY: DiagnosticTraversalPolicy = Object.freeze({
  causeFirst: true,
  includeStack: false,
  maxAggregateErrors: MAX_PUBLIC_AGGREGATE_ERRORS,
  maxDepth: MAX_PUBLIC_CAUSE_DEPTH,
  maxNodes: MAX_PUBLIC_ERROR_GRAPH_NODES,
  omitRepeatedReferences: true
});

interface DiagnosticNode {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly status?: number;
  readonly errors?: readonly DiagnosticNode[];
  readonly cause?: DiagnosticNode;
}

function diagnosticError(
  error: unknown,
  policy: DiagnosticTraversalPolicy = PRIVATE_DIAGNOSTIC_POLICY,
  depth = 0,
  traversal: ErrorTraversal = {
    seen: new Set<object>(),
    remaining: policy.maxNodes
  }
): DiagnosticNode | null {
  if (traversal.remaining <= 0) {
    return {
      name: "TruncatedErrorGraph",
      message: "Error graph limit reached"
    };
  }
  if (safeInstanceOfProviderError(error)) {
    traversal.remaining -= 1;
    return redactedProviderError(error);
  }
  if (!safeInstanceOfError(error)) {
    traversal.remaining -= 1;
    return { name: typeof error, message: bounded(safeString(error)) };
  }
  if (traversal.seen.has(error)) {
    return policy.omitRepeatedReferences
      ? null
      : {
          name: "CircularErrorReference",
          message: "Error already serialized"
        };
  }
  traversal.remaining -= 1;
  traversal.seen.add(error);
  const name = readErrorProperty(error, "name");
  const message = readErrorProperty(error, "message");
  const stack = policy.includeStack
    ? readErrorProperty(error, "stack")
    : undefined;
  const cause = readErrorProperty(error, "cause");
  const aggregateErrors = readAggregateErrors(error);
  let serializedCause: DiagnosticNode | null = null;
  const serializedErrors: DiagnosticNode[] = [];
  const serializeCause = (): void => {
    if (cause !== undefined && depth < policy.maxDepth) {
      serializedCause = diagnosticError(cause, policy, depth + 1, traversal);
    }
  };
  const serializeErrors = (): void => {
    if (aggregateErrors === null || depth >= policy.maxDepth) return;
    for (const entry of aggregateErrors) {
      const serialized = diagnosticError(
        entry,
        policy,
        depth + 1,
        traversal
      );
      if (serialized !== null) serializedErrors.push(serialized);
      if (serializedErrors.length >= policy.maxAggregateErrors) break;
    }
  };
  if (policy.causeFirst) {
    serializeCause();
    serializeErrors();
  } else {
    serializeErrors();
    serializeCause();
  }
  return {
    name: bounded(safeString(name ?? "Error")),
    message: bounded(safeString(message ?? "<unavailable>")),
    ...(stack === undefined ? {} : { stack: bounded(safeString(stack)) }),
    ...(serializedCause === null ? {} : { cause: serializedCause }),
    ...(serializedErrors.length === 0 ? {} : { errors: serializedErrors })
  };
}

function formatPublicDiagnostic(
  diagnostic: DiagnosticNode,
  depth = 0
): string {
  const name = compactPublicText(diagnostic.name, "Error");
  const message = compactPublicText(diagnostic.message, "<unavailable>");
  let result = `${name}: ${message}`;
  if (depth >= MAX_PUBLIC_CAUSE_DEPTH) return result;

  const cause = diagnostic.cause;
  if (cause !== undefined) {
    result += `; caused by ${formatPublicDiagnostic(cause, depth + 1)}`;
  }
  if (diagnostic.errors !== undefined) {
    const summaries = diagnostic.errors
      .map((entry) => formatPublicDiagnostic(entry, depth + 1));
    if (summaries.length > 0) {
      result += `; also ${summaries.join("; ")}`;
    }
  }
  return result;
}

function compactPublicText(value: unknown, fallback: string): string {
  const text = safeString(value).replace(/\s+/gu, " ").trim();
  return text.length === 0 ? fallback : text;
}

function redactedProviderError(error: ProviderError): DiagnosticNode {
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
