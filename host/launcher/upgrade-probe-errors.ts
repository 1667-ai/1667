/**
 * Maps executable probe failures into UpgradeFailure without importing
 * upgrade-apply or install-transaction (avoids cycles).
 */
import { ExecutableProbeError } from "../../shared/executable-probe.js";
import { UpgradeFailure } from "./upgrade-contract.js";

/**
 * Translate ExecutableProbeError only. Order: rethrow UpgradeFailure; if
 * ExecutableProbeError then signal.aborted → interrupted else verification_failed;
 * every other error is rethrown unchanged (including with an aborted signal).
 */
export function throwUpgradeProbeFailure(
  error: unknown,
  signal: AbortSignal,
  verificationFallback = "Executable version probe failed."
): never {
  if (error instanceof UpgradeFailure) throw error;
  if (error instanceof ExecutableProbeError) {
    if (signal.aborted) {
      throw new UpgradeFailure("interrupted", "The update was interrupted.");
    }
    throw new UpgradeFailure(
      "verification_failed",
      error.message.length > 0 ? error.message : verificationFallback
    );
  }
  throw error;
}
