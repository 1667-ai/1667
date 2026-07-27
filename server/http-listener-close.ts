import { BACKEND_SHUTDOWN_GRACE_MS } from "../shared/types.js";
import {
  shutDownHttpListener,
  type HttpCleanupFailure,
  type HttpListenerResources
} from "./http-listener-lifecycle.js";
import type { HttpReadiness } from "./http-readiness.js";
import type {
  InternalErrorReporter
} from "./internal-error-reporter.js";
import { localStartupFailure } from "./local-startup-failure.js";
import { errorFromFailureIncident } from "./reported-service-error.js";
import { prepareServiceFailure } from "./service-error-policy.js";

export interface HttpListenerCloseFailure {
  readonly error: unknown;
  readonly operation: string;
  readonly phase: "process" | "startup";
}

interface LateDiagnostic {
  readonly completion: Promise<HttpCleanupFailure>;
  readonly service: string;
  readonly operation: string;
}

const LATE_DIAGNOSTIC_GRACE_MS = 250;
type LateReporterFactory = () => Promise<InternalErrorReporter>;

/** Idempotent close owner for one fully lexical listener startup. */
export class HttpListenerCloser {
  private settlement: Promise<HttpCleanupFailure> | null = null;

  constructor(
    private readonly resources: HttpListenerResources,
    private readonly readiness: HttpReadiness,
    private readonly errorReporter: InternalErrorReporter,
    private readonly openLateReporter: LateReporterFactory,
    private readonly shutdownGraceMs = BACKEND_SHUTDOWN_GRACE_MS
  ) {}

  async close(
    processFailure?: HttpListenerCloseFailure
  ): Promise<HttpCleanupFailure> {
    this.settlement ??= this.closeOnce(processFailure);
    return await this.settlement;
  }

  private async closeOnce(
    processFailure?: HttpListenerCloseFailure
  ): Promise<HttpCleanupFailure> {
    this.readiness.stopAccepting();
    const shutdownDeadline = performance.now() + this.shutdownGraceMs;
    const shutdown = await shutDownHttpListener(
      this.resources,
      this.shutdownGraceMs
    );
    const readinessFailure = this.readiness.currentFailure();
    const readinessIsPrimary = processFailure === undefined
      && readinessFailure.kind === "failure";
    const phase = readinessIsPrimary ? "process" : processFailure?.phase;
    const primaryError = readinessIsPrimary
      ? readinessFailure.error
      : processFailure?.phase === "startup"
        ? localStartupFailure(processFailure.error)
        : processFailure?.error;
    const failure = combineFailures(
      processFailure !== undefined || readinessIsPrimary,
      primaryError,
      shutdown.immediate,
      phase
    );

    for (const completion of shutdown.completions) {
      reportEventually({
        completion,
        service: "http-server-shutdown",
        operation: "late-cleanup"
      }, this.openLateReporter);
    }
    const readinessCompletion = this.readiness.pendingFailure();
    if (readinessCompletion !== null && !readinessIsPrimary) {
      reportEventually({
        completion: readinessCompletion,
        service: "http-server-process",
        operation: "ready-callback"
      }, this.openLateReporter);
    }

    try {
      if (failure.kind === "none") return failure;
      const report = this.errorReporter.report(failure.error, {
        service: phase === "startup"
          ? "http-server-startup"
          : phase === "process"
            ? "http-server-process"
            : "http-server-shutdown",
        operation: processFailure?.operation
          ?? (readinessIsPrimary ? "ready-callback" : "shutdown")
      }).catch(() => prepareServiceFailure(failure.error));
      const reported = await withinDeadline(report, shutdownDeadline);
      return {
        kind: "failure",
        error: errorFromFailureIncident(
          reported ?? prepareServiceFailure(failure.error)
        )
      };
    } finally {
      await withinDeadline(
        this.errorReporter.close().catch(() => undefined),
        shutdownDeadline
      );
    }
  }
}

function reportEventually(
  diagnostic: LateDiagnostic,
  openReporter: LateReporterFactory
): void {
  void diagnostic.completion.then(async (outcome) => {
    if (outcome.kind === "none") return;
    const reporter = await openReporter();
    try {
      await reporter.report(outcome.error, {
        service: diagnostic.service,
        operation: diagnostic.operation
      });
    } finally {
      await withinDeadline(
        reporter.close().catch(() => undefined),
        performance.now() + LATE_DIAGNOSTIC_GRACE_MS
      );
    }
  }).catch(() => undefined);
}

function combineFailures(
  hasPrimaryError: boolean,
  primaryError: unknown,
  cleanup: HttpCleanupFailure,
  phase: HttpListenerCloseFailure["phase"] | undefined
): HttpCleanupFailure {
  if (!hasPrimaryError) return cleanup;
  if (cleanup.kind === "none") {
    return { kind: "failure", error: primaryError };
  }
  return {
    kind: "failure",
    error: new AggregateError(
      [primaryError, ...aggregateEntries(cleanup.error)],
      phase === "startup"
        ? "1667 HTTP listener startup and cleanup both failed"
        : "1667 HTTP process and listener cleanup both failed",
      { cause: primaryError }
    )
  };
}

async function withinDeadline<T>(
  operation: Promise<T>,
  deadline: number
): Promise<T | null> {
  const remaining = Math.max(
    0,
    deadline - performance.now()
  );
  if (remaining === 0) {
    void operation.catch(() => undefined);
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    operation.then((value) => ({ kind: "value" as const, value })),
    new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
    })
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return result.kind === "value" ? result.value : null;
}

function aggregateEntries(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors : [error];
}
