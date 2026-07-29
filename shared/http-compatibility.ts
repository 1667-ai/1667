import {
  HTTP_API_PROTOCOL_VERSION,
  HTTP_CLIENT_PROTOCOL_HEADER,
  HTTP_SERVER_INSTANCE_HEADER,
  isHttpRecoveryWarning,
  type HttpApiMetadata
} from "./http-protocol.js";
import { isBuildIdentity } from "./build-identity.js";
import { isHttpDataDirectoryId } from "./http-data-directory-id.js";
import {
  bearerAuthorization,
  HTTP_AUTHORIZATION_HEADER
} from "./http-auth.js";

export type HttpCompatibilityFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export class IncompatibleHttpApiError extends Error {}
export class InvalidHttpApiMetadataError extends Error {}

export interface HttpCompatibilityAuthority {
  readonly capability: string;
  readonly serverInstanceId: string;
}

export async function preflightHttpApi(
  endpoint: string,
  signal: AbortSignal | undefined,
  fetcher: HttpCompatibilityFetch,
  authority: HttpCompatibilityAuthority
): Promise<HttpApiMetadata> {
  const timeout = AbortSignal.timeout(5_000);
  const response = await fetcher(endpoint, {
    headers: {
      [HTTP_AUTHORIZATION_HEADER]:
        bearerAuthorization(authority.capability),
      [HTTP_CLIENT_PROTOCOL_HEADER]:
        String(HTTP_API_PROTOCOL_VERSION),
      [HTTP_SERVER_INSTANCE_HEADER]: authority.serverInstanceId
    },
    redirect: "error",
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  });
  const value: unknown = await response.json().catch(() => null);
  if (response.status === 503) {
    throw new Error(
      "The loopback 1667 server is not ready"
    );
  }
  if (!response.ok || value === null || typeof value !== "object") {
    throw invalidMetadata();
  }
  const buildIdentity = (value as Partial<HttpApiMetadata>).buildIdentity;
  if (!isBuildIdentity(buildIdentity)) {
    throw invalidMetadata();
  }
  if (buildIdentity.minClientProtocolVersion > HTTP_API_PROTOCOL_VERSION
    || buildIdentity.maxClientProtocolVersion < HTTP_API_PROTOCOL_VERSION) {
    throw new IncompatibleHttpApiError(
      `Incompatible 1667 server API ${buildIdentity.apiProtocolVersion}; upgrade the client or server before continuing`
    );
  }
  if (!isHttpApiMetadata(value)) {
    throw invalidMetadata();
  }
  return value;
}

function invalidMetadata(): InvalidHttpApiMetadataError {
  return new InvalidHttpApiMetadataError(
    "The loopback 1667 server returned invalid compatibility metadata"
  );
}

function isHttpApiMetadata(value: unknown): value is HttpApiMetadata {
  if (value === null || typeof value !== "object") return false;
  const metadata = value as Partial<HttpApiMetadata>;
  if (!isBuildIdentity(metadata.buildIdentity)) return false;
  return isHttpDataDirectoryId(metadata.dataDirectoryClaimId)
    && isHttpDataDirectoryId(metadata.dataDirectoryId)
    && typeof metadata.serverInstanceId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(metadata.serverInstanceId)
    && Array.isArray(metadata.recoveryWarnings)
    && metadata.recoveryWarnings.every(isHttpRecoveryWarning);
}
