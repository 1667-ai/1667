import {
  formatInternalErrorMessage,
  type InternalErrorContext
} from "./internal-error-format.js";
import { printInternalError } from "./internal-error-log.js";
import { resolveMachineTierRoot } from "./machine-tier.js";
import { PublicRuntimeError } from "./errors.js";
import { PlatformStateRootError } from "./platform-state-root.js";

interface DiagnosticMachineTierOptions {
  readonly print?: boolean;
  readonly resolve?: () => Promise<string>;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
}

/** Resolve diagnostic storage before its reporter exists. */
export async function resolveDiagnosticMachineTier(
  configured: string | undefined,
  context: InternalErrorContext,
  options: DiagnosticMachineTierOptions = {}
): Promise<string> {
  if (configured !== undefined) return configured;
  try {
    return await (options.resolve ?? resolveMachineTierRoot)();
  } catch (error) {
    if (options.print === true) {
      printInternalError(
        error,
        context,
        options.stderr ?? process.stderr
      );
    }
    throw diagnosticMachineTierFailure(error);
  }
}

export function diagnosticMachineTierFailure(
  error: unknown
): PublicRuntimeError {
  return new PublicRuntimeError(
    error instanceof PlatformStateRootError
      ? error.message
      : formatInternalErrorMessage(error),
    { cause: error }
  );
}
