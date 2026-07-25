import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import { isCanonicalLoopbackOrigin } from "./http-loopback-origin.js";

export const HTTP_AUTHORIZATION_HEADER = "authorization";
export const HTTP_AUTH_RECORD_SCHEMA = 1;
export const HTTP_INSTANCE_SCHEMA = 1;
export const MAX_HTTP_AUTH_RECORD_BYTES = 4_096;
export const MAX_HTTP_INSTANCE_BYTES = 4_096;

export type HttpCapabilityScope = "story" | "admin";

export interface HttpCapabilities {
  readonly story: string;
  readonly admin: string;
}

export interface HttpAuthRecord {
  readonly schema: 1;
  readonly origin: string;
  readonly instanceId: string;
  readonly capabilities: HttpCapabilities;
}

export interface HttpInstanceMetadata {
  readonly schema: 1;
  readonly origin: string;
  readonly instanceId: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;

export function decodeHttpAuthRecord(bytes: Uint8Array): HttpAuthRecord {
  if (bytes.byteLength > MAX_HTTP_AUTH_RECORD_BYTES) {
    throw new Error("1667 HTTP auth record exceeds 4096 bytes");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = parseJsonRejectingDuplicateKeys(text);
  requireExactObject(value, ["schema", "origin", "instanceId", "capabilities"], "HTTP auth record");
  const record = value as Record<string, unknown>;
  requireSchema(record.schema, HTTP_AUTH_RECORD_SCHEMA, "HTTP auth record");
  if (typeof record.origin !== "string" || !isCanonicalLoopbackOrigin(record.origin)) {
    throw new Error("1667 HTTP auth record has an invalid origin");
  }
  requireInstanceId(record.instanceId, "HTTP auth record");
  requireExactObject(record.capabilities, ["story", "admin"], "HTTP auth capabilities");
  const capabilities = record.capabilities as Record<string, unknown>;
  requireCapability(capabilities.story, "story");
  requireCapability(capabilities.admin, "admin");
  if (capabilities.story === capabilities.admin) {
    throw new Error("1667 HTTP capabilities must be independent");
  }
  const decoded: HttpAuthRecord = {
    schema: 1,
    origin: record.origin,
    instanceId: record.instanceId,
    capabilities: {
      story: capabilities.story,
      admin: capabilities.admin
    }
  };
  if (text !== encodeHttpAuthRecord(decoded)) {
    throw new Error("1667 HTTP auth record is not canonical JSON");
  }
  return decoded;
}

export function encodeHttpAuthRecord(record: HttpAuthRecord): string {
  return `{"capabilities":{"admin":${JSON.stringify(record.capabilities.admin)},`
    + `"story":${JSON.stringify(record.capabilities.story)}},`
    + `"instanceId":${JSON.stringify(record.instanceId)},`
    + `"origin":${JSON.stringify(record.origin)},"schema":1}`;
}

export function decodeHttpInstanceMetadata(value: unknown): HttpInstanceMetadata {
  requireExactObject(value, ["schema", "origin", "instanceId"], "HTTP instance metadata");
  const metadata = value as Record<string, unknown>;
  requireSchema(metadata.schema, HTTP_INSTANCE_SCHEMA, "HTTP instance metadata");
  if (typeof metadata.origin !== "string" || !isCanonicalLoopbackOrigin(metadata.origin)) {
    throw new Error("1667 HTTP instance metadata has an invalid origin");
  }
  requireInstanceId(metadata.instanceId, "HTTP instance metadata");
  return {
    schema: 1,
    origin: metadata.origin,
    instanceId: metadata.instanceId
  };
}

export async function decodeHttpInstanceMetadataResponse(
  response: Response
): Promise<HttpInstanceMetadata> {
  if (response.body === null) {
    throw new Error("1667 HTTP instance metadata response has no body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_HTTP_INSTANCE_BYTES) {
        await reader.cancel();
        throw new Error("1667 HTTP instance metadata exceeds 4096 bytes");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return decodeHttpInstanceMetadata(parseJsonRejectingDuplicateKeys(text));
}

export function bearerAuthorization(capability: string): string {
  requireCapability(capability, "authorization");
  return `Bearer ${capability}`;
}

export function isHttpInstanceId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function requireSchema(value: unknown, expected: number, label: string): void {
  if (value !== expected) {
    throw new Error(`${label} has an unsupported schema`);
  }
}

function requireInstanceId(value: unknown, label: string): asserts value is string {
  if (!isHttpInstanceId(value)) throw new Error(`${label} has an invalid instance ID`);
}

function requireCapability(value: unknown, scope: string): asserts value is string {
  if (typeof value !== "string" || !CAPABILITY_PATTERN.test(value)) {
    throw new Error(`1667 ${scope} capability is invalid`);
  }
}

function requireExactObject(
  value: unknown,
  keys: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}
