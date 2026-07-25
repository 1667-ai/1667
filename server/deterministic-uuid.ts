/** Format a SHA-256 digest as a v4-shaped UUID.
 *
 * The version nibble is fixed at 4 and the variant at `a`; both are constants
 * rather than digest material, because a deterministic ID's entropy comes from
 * what was hashed, not from which interchangeable variant character it wears.
 */
export function uuidFromDigestHex(hex: string): string {
  if (hex.length < 32) throw new Error("Deterministic UUID needs at least 32 hex characters");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join("-");
}
