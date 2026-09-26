import type { BridgeRecoveryWarning } from "../../../shared/web-bridge-protocol.js";

export function RecoveryBanner(
  { warnings, onDismiss }: {
    readonly warnings: readonly BridgeRecoveryWarning[];
    readonly onDismiss: (mutationId: string) => void;
  }
) {
  return (
    <div className="recovery-banner" role="status">
      <p className="recovery-banner-heading">
        {warnings.length} recovery warning{warnings.length === 1 ? "" : "s"}
      </p>
      <ul>
        {warnings.map((warning) => (
          <li key={warning.mutationId}>
            <span>{warning.method} ({warning.resolution}): {warning.error.message}</span>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => onDismiss(warning.mutationId)}
            >
              Dismiss
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
