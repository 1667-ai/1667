import { prepareServiceFailure } from "./service-error-policy.js";
import type { DiagnosticReference } from "../shared/diagnostic-reference.js";
import {
  InternalErrorLog,
  printInternalError,
  type InternalErrorContext
} from "./internal-error-log.js";
import {
  loggedFailureIncident,
  type ServiceFailureIncident
} from "./reported-service-error.js";

export interface InternalErrorReporterOptions {
  readonly print?: boolean;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
}

export type ReportedError = ServiceFailureIncident;

type ReporterDestination =
  | { readonly kind: "disabled" }
  | { readonly kind: "persistent"; readonly log: InternalErrorLog }
  | {
      readonly kind: "unavailable";
      readonly stderr: Pick<NodeJS.WriteStream, "write"> | null;
    };

/** Transport-neutral private diagnostic persistence and exposure policy. */
export class InternalErrorReporter {
  private closePromise: Promise<void> | null = null;

  private constructor(private readonly destination: ReporterDestination) {}

  static disabled(): InternalErrorReporter {
    return new InternalErrorReporter({ kind: "disabled" });
  }

  static async open(
    machineDir: string,
    options: InternalErrorReporterOptions = {}
  ): Promise<InternalErrorReporter> {
    const stderr = options.stderr ?? process.stderr;
    try {
      return new InternalErrorReporter({
        kind: "persistent",
        log: await InternalErrorLog.open(machineDir, {
          print: options.print,
          stderr
        })
      });
    } catch (error) {
      writeUnavailableWarning(stderr, error, options.print === true);
      return new InternalErrorReporter({
        kind: "unavailable",
        stderr: options.print === true ? stderr : null
      });
    }
  }

  async report(
    error: unknown,
    context: InternalErrorContext
  ): Promise<ReportedError> {
    const prepared = prepareServiceFailure(error);
    if (prepared.persistence !== "unreported") {
      return prepared;
    }
    let reference: DiagnosticReference | undefined;
    if (this.destination.kind === "persistent") {
      const report = await this.destination.log.record(
        prepared.diagnostic,
        context
      );
      reference = report?.ref;
    } else if (
      this.destination.kind === "unavailable"
      && this.destination.stderr !== null
    ) {
      printInternalError(
        prepared.diagnostic,
        context,
        this.destination.stderr
      );
    }
    return loggedFailureIncident(prepared, reference);
  }

  async close(): Promise<void> {
    this.closePromise ??= this.destination.kind === "persistent"
      ? this.destination.log.close()
      : Promise.resolve();
    await this.closePromise;
  }
}

/** Owns a reporter until one runtime boundary accepts its lifetime. */
export class InternalErrorReporterLease {
  private reporter: InternalErrorReporter | null;

  constructor(reporter: InternalErrorReporter) {
    this.reporter = reporter;
  }

  transfer(): InternalErrorReporter {
    const reporter = this.reporter;
    if (reporter === null) {
      throw new Error("Internal error reporter lease was already transferred");
    }
    this.reporter = null;
    return reporter;
  }

  async close(): Promise<void> {
    const reporter = this.reporter;
    this.reporter = null;
    await reporter?.close();
  }
}

function writeUnavailableWarning(
  stderr: Pick<NodeJS.WriteStream, "write">,
  error: unknown,
  printDetails: boolean
): void {
  try {
    const detail = printDetails ? `: ${String(error)}` : "";
    stderr.write([
      `1667: internal error log is unavailable${detail}. `,
      "Unexpected failures will not have persistent diagnostic references. ",
      "Retry with --print-logs for stderr diagnostics.\n"
    ].join(""));
  } catch {
    // A diagnostic destination cannot become a startup failure.
  }
}
