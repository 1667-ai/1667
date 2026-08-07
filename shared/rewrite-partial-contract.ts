import { createHash } from "node:crypto";

const STREAM_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const STREAM_DIGEST_DOMAIN = "1667-partial-rewrite\0";

/** A fixed-size identity for the exact UTF-8 rewrite stream. */
export function rewriteStreamDigest(streamedText: string): string {
  return createHash("sha256")
    .update(STREAM_DIGEST_DOMAIN, "utf8")
    .update(streamedText, "utf8")
    .digest("hex");
}

export function isRewriteStreamDigest(value: unknown): value is string {
  return typeof value === "string" && STREAM_DIGEST_PATTERN.test(value);
}
