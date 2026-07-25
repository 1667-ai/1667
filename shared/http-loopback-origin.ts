const IPV4_OCTET = "(?:0|[1-9][0-9]{0,2})";
const LOOPBACK_ORIGIN = new RegExp(
  `^http:\\/\\/(127\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}|\\[::1\\])(?::(0|[1-9][0-9]{0,4}))?\\/?$`
);

export interface CanonicalLoopbackOrigin {
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
}

/** Parse only canonical numeric HTTP loopback origins. DNS is never involved. */
export function parseCanonicalLoopbackOrigin(input: string): CanonicalLoopbackOrigin {
  const match = LOOPBACK_ORIGIN.exec(input);
  if (match === null) throw invalidOrigin();
  const hostname = match[1]!;
  if (hostname.startsWith("127.")) {
    const octets = hostname.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) throw invalidOrigin();
  }
  const explicitPort = match[2] === undefined ? 80 : Number(match[2]);
  if (!Number.isSafeInteger(explicitPort) || explicitPort < 1 || explicitPort > 65_535) {
    throw invalidOrigin();
  }
  const parsed = new URL(input);
  if (input !== parsed.origin && input !== `${parsed.origin}/`) throw invalidOrigin();
  return { origin: parsed.origin, hostname, port: explicitPort };
}

export function isCanonicalLoopbackOrigin(input: string): boolean {
  try {
    parseCanonicalLoopbackOrigin(input);
    return true;
  } catch {
    return false;
  }
}

function invalidOrigin(): Error {
  return new Error(
    "1667 server URL must be a canonical numeric loopback HTTP origin"
  );
}
