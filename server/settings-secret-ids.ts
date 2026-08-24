/** IDs minted by this project's sidecar: a crypto-UUID suffix that cannot
 *  predate the mint-per-key change and cannot arise from another writer's
 *  connection-derived or caller-selected naming. Only these ever qualify for
 *  targeted supersession deletion in the shared machine tier. */
export const MINTED_SECRET_ID_PATTERN =
  /\.k[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isMintedSecretId(secretId: string): boolean {
  return MINTED_SECRET_ID_PATTERN.test(secretId);
}
