const DOMAIN = "1667-partial-rewrite\0";

/** The identity of the exact rewrite text this page watched stream, as the
 * server checks it before it commits a stopped rewrite: SHA-256 over a fixed
 * prefix and the UTF-8 text, in lower-case hex. It is the same value
 * `rewriteStreamDigest` (`shared/rewrite-partial-contract.ts`) makes with
 * `node:crypto`; the page has only Web Crypto. */
export async function rewriteStreamDigest(streamedText: string): Promise<string> {
  const bytes = new TextEncoder().encode(DOMAIN + streamedText);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
