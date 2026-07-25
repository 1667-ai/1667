export type HttpHostClass =
  | "loopback"
  | "private-literal"
  | "lan-hostname"
  | "other";

/** Browser-safe host classification shared by document validation and every
 * provider transport. Callers validate URL shape separately. */
export function classifyHttpHost(baseUrlOrHostname: string): HttpHostClass {
  const hostname = normalizedHostname(baseUrlOrHostname);
  const ipv4 = ipv4Octets(hostname);
  if (
    hostname === "localhost"
    || hostname === "::1"
    || (ipv4 !== null && ipv4[0] === 127)
  ) {
    return "loopback";
  }
  if (
    ipv4 !== null
    && (
      ipv4[0] === 10
      || (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168)
    )
  ) {
    return "private-literal";
  }
  if (/^(?:fc|fd)[0-9a-f]{2}:/u.test(hostname)) return "private-literal";
  if (
    !hostname.includes(":")
    && (hostname.endsWith(".local") || !hostname.includes("."))
  ) {
    return "lan-hostname";
  }
  return "other";
}

function normalizedHostname(baseUrlOrHostname: string): string {
  let hostname = baseUrlOrHostname;
  try {
    hostname = new URL(baseUrlOrHostname).hostname;
  } catch {
    // Hostname-only callers deliberately avoid manufacturing a URL.
  }
  return hostname.toLowerCase().replace(/^\[|\]$/gu, "");
}

function ipv4Octets(hostname: string): readonly number[] | null {
  if (!/^[0-9]+(?:\.[0-9]+){3}$/u.test(hostname)) return null;
  const octets = hostname.split(".").map(Number);
  return octets.every((part) =>
    Number.isInteger(part) && part >= 0 && part <= 255
  )
    ? octets
    : null;
}
