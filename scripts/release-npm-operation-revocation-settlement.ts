export const NPM_OPERATION_REVOCATION_SETTLE_MS = 600_000;

export function requireNpmOperationRevocationSettled(
  revokedAt: string,
  now: number
): void {
  if (now - Date.parse(revokedAt) < NPM_OPERATION_REVOCATION_SETTLE_MS) {
    throw new Error(
      "npm operation lease revocation did not settle for ten minutes"
    );
  }
}
