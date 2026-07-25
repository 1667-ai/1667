/** The currently shipped ownership proof reads Linux's per-account socket
 * tables. Other targets must not advertise plaintext local-provider setup. */
export function ownedLoopbackHttpSupportedOn(
  platform: string,
  hasNumericUserId: boolean
): boolean {
  return platform === "linux" && hasNumericUserId;
}
