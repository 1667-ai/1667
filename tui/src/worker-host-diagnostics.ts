import {
  diagnosticReferenceFromFailure
} from "../../shared/failure-envelope.js";
import { InternalErrorReporter } from "../../server/internal-error-reporter.js";
import type { PendingRequestDiagnostic } from "./worker-pending.js";
import { BackendRestartRequiredError } from "./worker-error.js";

export interface EmbeddedWorkerHostSnapshot {
  readonly pendingCount: number;
  readonly omittedCount: number;
  readonly operations: readonly PendingRequestDiagnostic[];
}

/** Add content-free host state to a failure that the worker cannot report. */
export function embeddedWorkerHostCause(
  cause: unknown,
  snapshot: EmbeddedWorkerHostSnapshot
): Error {
  const diagnostic = new Error(
    `Embedded backend host state: ${JSON.stringify(snapshot)}`,
    cause === undefined ? undefined : { cause }
  );
  diagnostic.name = "EmbeddedWorkerHostDiagnostic";
  return diagnostic;
}

/** Persist the final host-side hard fence before the CLI exits. */
export async function reportEmbeddedWorkerHostFailure(
  error: Error,
  machineDir: string | undefined,
  print: boolean
): Promise<Error> {
  if (!(error instanceof BackendRestartRequiredError)
    || error.diagnosticRef !== null
    || machineDir === undefined) {
    return error;
  }
  let reporter: InternalErrorReporter | undefined;
  try {
    reporter = await InternalErrorReporter.open(machineDir, { print });
    const incident = await reporter.report(error, {
      service: "embedded-worker-host",
      operation: "restart-required"
    });
    error.attachDiagnosticReference(
      diagnosticReferenceFromFailure(incident.failure)
    );
  } catch {
    // A failed diagnostic cannot replace the hard fence that it describes.
  } finally {
    await reporter?.close().catch(() => undefined);
  }
  return error;
}
