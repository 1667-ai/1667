import type { WebAsset } from "../../host/web-server.js";

/**
 * The define/cache-file form of `WebAsset`: `Bun.build`'s `define` splices a
 * `JSON.stringify`d value in as source text (the same pattern
 * `worker-transport.ts`'s `__AI_1667_EMBEDDED_WORKER_SOURCE__` uses), and a
 * JSON document has no byte-string type — a binary body (a woff2 font) has to
 * travel as base64 both in that literal and in the on-disk build cache. One
 * shape covers both: `encodeWebAssets`/`decodeWebAssets` are the only
 * conversion between this and the in-memory `WebAsset.body: Uint8Array`.
 *
 * This file has no `Bun`-only reference on purpose: `cli/scripts/
 * standalone-build-requests.ts` imports `encodeWebAssets` as a value, and it
 * is reachable (through `test/standalone-compile-target.test.ts`) from the
 * root `tsconfig.json` program, which has no Bun globals. Keeping
 * `cli/src/web-assets.ts`'s `Bun.build` call out of this file keeps that
 * program buildable.
 */
export interface EncodedWebAsset {
  readonly contentType: string;
  readonly base64: string;
}

export function encodeWebAssets(
  assets: ReadonlyMap<string, WebAsset>
): Readonly<Record<string, EncodedWebAsset>> {
  const encoded: Record<string, EncodedWebAsset> = {};
  for (const [assetPath, asset] of assets) {
    encoded[assetPath] = {
      contentType: asset.contentType,
      base64: Buffer.from(asset.body).toString("base64")
    };
  }
  return encoded;
}

export function decodeWebAssets(
  encoded: Readonly<Record<string, EncodedWebAsset>>
): ReadonlyMap<string, WebAsset> {
  return new Map(Object.entries(encoded).map(([assetPath, asset]) => [
    assetPath,
    { contentType: asset.contentType, body: new Uint8Array(Buffer.from(asset.base64, "base64")) }
  ]));
}
