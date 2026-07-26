import {
  isDiagnosticReference,
  type DiagnosticReference
} from "../shared/diagnostic-reference.js";
import path from "node:path";
import { createDiagnosticReference } from "./diagnostic-reference.js";
import {
  formatInternalErrorDiagnostic,
  formatInternalErrorEmergency,
  formatInternalErrorFallback,
  type InternalErrorContext
} from "./internal-error-format.js";
import { PrivateRotatingJsonlStore } from "./private-rotating-jsonl-store.js";

const LOG_DIRECTORY = "log";
const LOG_FILE = "1667.log";
const LOG_LOCK_FILE = "1667.lock";
export const MAX_INTERNAL_ERROR_LOG_BYTES = 5 * 1024 * 1024;

export type { InternalErrorContext } from "./internal-error-format.js";

export interface InternalErrorReport {
  readonly ref: DiagnosticReference;
  readonly file: string;
}

export interface InternalErrorLogOptions {
  readonly print?: boolean;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  /** Test hook for directory durability barriers. */
  readonly syncDirectories?: (file: string) => Promise<void>;
}

/**
 * Private, bounded diagnostics for errors whose public form is deliberately
 * generic. The machine tier already holds secrets; its log directory and file
 * retain the same owner-only policy.
 */
export class InternalErrorLog {
  private constructor(
    private readonly store: PrivateRotatingJsonlStore,
    private readonly print: boolean,
    private readonly stderr: Pick<NodeJS.WriteStream, "write">
  ) {}

  get file(): string {
    return this.store.file;
  }

  static async open(
    machineDir: string,
    options: InternalErrorLogOptions = {}
  ): Promise<InternalErrorLog> {
    return new InternalErrorLog(
      await PrivateRotatingJsonlStore.open(machineDir, {
        directoryName: LOG_DIRECTORY,
        fileName: LOG_FILE,
        lockFileName: LOG_LOCK_FILE,
        maximumBytes: MAX_INTERNAL_ERROR_LOG_BYTES,
        syncDirectories: options.syncDirectories
      }),
      options.print === true,
      options.stderr ?? process.stderr
    );
  }

  record(
    error: unknown,
    context: InternalErrorContext,
    reference?: string
  ): Promise<InternalErrorReport | null> {
    return this.recordExclusive(error, context, reference);
  }

  close(): Promise<void> {
    return this.store.close();
  }

  private async recordExclusive(
    error: unknown,
    context: InternalErrorContext,
    reference?: string
  ): Promise<InternalErrorReport | null> {
    let diagnostic: FormattedDiagnostic;
    try {
      diagnostic = formatDiagnostic(error, context, reference);
    } catch (formatError) {
      writeRuntimeUnavailableWarning(this.stderr, "formatting failed");
      if (this.print) {
        safeWrite(
          this.stderr,
          formatInternalErrorEmergency(
            error,
            formatError,
            new Date().toISOString()
          )
        );
      }
      return null;
    }
    try {
      await this.store.append(Buffer.from(diagnostic.line));
    } catch (writeError) {
      if (this.print) {
        safeWrite(this.stderr, diagnostic.line);
        safeWrite(
          this.stderr,
          formatInternalErrorFallback(
            diagnostic.ref,
            "log write failed",
            writeError,
            new Date().toISOString()
          )
        );
      }
      writeRuntimeUnavailableWarning(this.stderr, "append failed");
      return null;
    }
    if (this.print) safeWrite(this.stderr, diagnostic.line);
    return { ref: diagnostic.ref, file: this.file };
  }

}

export function internalErrorLogPath(machineDir: string): string {
  return path.join(machineDir, LOG_DIRECTORY, LOG_FILE);
}

export function internalErrorLogLockPath(machineDir: string): string {
  return path.join(machineDir, LOG_DIRECTORY, LOG_LOCK_FILE);
}

export function printInternalError(
  error: unknown,
  context: InternalErrorContext,
  stderr: Pick<NodeJS.WriteStream, "write">,
  reference?: string
): void {
  try {
    safeWrite(stderr, formatDiagnostic(error, context, reference).line);
  } catch (formatError) {
    safeWrite(
      stderr,
      formatInternalErrorEmergency(
        error,
        formatError,
        new Date().toISOString()
      )
    );
  }
}

interface FormattedDiagnostic {
  readonly ref: DiagnosticReference;
  readonly line: string;
}

function formatDiagnostic(
  error: unknown,
  context: InternalErrorContext,
  reference?: string
): FormattedDiagnostic {
  const ref = isDiagnosticReference(reference)
    ? reference
    : createDiagnosticReference();
  return {
    ref,
    line: formatInternalErrorDiagnostic(
      error,
      context,
      ref,
      new Date().toISOString(),
      MAX_INTERNAL_ERROR_LOG_BYTES
    )
  };
}

function safeWrite(
  destination: Pick<NodeJS.WriteStream, "write">,
  value: string
): void {
  try {
    destination.write(value);
  } catch {
    // Diagnostics must never replace the original worker error.
  }
}

function writeRuntimeUnavailableWarning(
  stderr: Pick<NodeJS.WriteStream, "write">,
  stage: string
): void {
  safeWrite(
    stderr,
    `1667: internal error log ${stage}; this diagnostic was not persisted. `
      + "Retry with --print-logs for stderr diagnostics.\n"
  );
}
