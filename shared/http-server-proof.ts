import {
  createHmac,
  timingSafeEqual
} from "node:crypto";
import type { HttpAuthRecord } from "./http-auth.js";

export const HTTP_SERVER_PROOF_PATH = "/.well-known/1667-proof";
export const HTTP_SERVER_PROOF_HEADER = "x-1667-server-proof";
export const HTTP_SERVER_PROOF_NONCE_BYTES = 32;

const NONCE_PATTERN = /^[0-9a-f]{64}$/;
const PROOF_PATTERN = /^[0-9a-f]{64}$/;

export function isHttpServerProofNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

export function createHttpServerProof(
  record: HttpAuthRecord,
  nonce: string
): string {
  if (!isHttpServerProofNonce(nonce)) {
    throw new Error("1667 HTTP server-proof nonce is invalid");
  }
  return createHmac(
    "sha256",
    Buffer.from(record.capabilities.admin, "hex")
  ).update(
    `1667-http-server-proof-v1\0${record.origin}\0`
      + `${record.instanceId}\0${nonce}`,
    "utf8"
  ).digest("hex");
}

export function matchesHttpServerProof(
  record: HttpAuthRecord,
  nonce: string,
  candidate: unknown
): boolean {
  if (typeof candidate !== "string" || !PROOF_PATTERN.test(candidate)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(createHttpServerProof(record, nonce), "hex"),
    Buffer.from(candidate, "hex")
  );
}
