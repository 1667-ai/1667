import {
  HTTP_API_PROTOCOL_VERSION,
  isHttpRecoveryWarning,
  type HttpApiMetadata
} from "./http-protocol.js";
import { isBuildIdentity } from "./build-identity.js";

export type HttpCompatibilityFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export async function preflightHttpApi(
  endpoint: string,
  signal?: AbortSignal,
  fetcher: HttpCompatibilityFetch = fetch
): Promise<HttpApiMetadata> {
  const timeout = AbortSignal.timeout(5_000);
  const response = await fetcher(endpoint, {
    redirect: "error",
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !isHttpApiMetadata(value)) {
    throw new Error("The loopback 1667 server returned invalid compatibility metadata");
  }
  if (value.buildIdentity.minClientProtocolVersion > HTTP_API_PROTOCOL_VERSION
    || value.buildIdentity.maxClientProtocolVersion < HTTP_API_PROTOCOL_VERSION) {
    throw new Error(
      `Incompatible 1667 server API ${value.buildIdentity.apiProtocolVersion}; upgrade the client or server before continuing`
    );
  }
  return value;
}

function isHttpApiMetadata(value: unknown): value is HttpApiMetadata {
  if (value === null || typeof value !== "object") return false;
  const metadata = value as Partial<HttpApiMetadata>;
  if (!isBuildIdentity(metadata.buildIdentity)) return false;
  return typeof metadata.serverInstanceId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(metadata.serverInstanceId)
    && Array.isArray(metadata.recoveryWarnings)
    && metadata.recoveryWarnings.every(isHttpRecoveryWarning);
}
