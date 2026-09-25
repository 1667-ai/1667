import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebAsset } from "../../host/web-server.js";
import { decodeWebAssets, type EncodedWebAsset } from "./web-assets-codec.js";

/** A compiled build embeds the built assets under this identifier
 * (`cli/scripts/standalone-build-requests.ts`'s `define`), the same pattern
 * `worker-transport.ts`'s `__AI_1667_EMBEDDED_WORKER_SOURCE__` uses: `Bun.build`'s
 * `define` splices the `JSON.stringify`d value in as source text, so an
 * object value becomes a literal object expression here, not a string to
 * re-parse. It carries `EncodedWebAsset` entries (base64 bodies), not
 * `WebAsset` directly — see `cli/src/web-assets-codec.ts`. */
declare const __AI_1667_WEB_ASSETS__: Readonly<Record<string, EncodedWebAsset>> | undefined;

const webRoot = fileURLToPath(new URL("../../web", import.meta.url));

/**
 * The two files `host/web-server.ts` serves publicly: the shell page and its
 * bundled app script. A compiled `1667` has no `web/` directory to read at
 * runtime, so it always embeds these (`cli/scripts/build-standalone.ts`); a
 * source run (`bun src/standalone.ts`, or this repo's own tests) builds them
 * fresh every time instead.
 */
export async function loadWebAssets(): Promise<ReadonlyMap<string, WebAsset>> {
  if (typeof __AI_1667_WEB_ASSETS__ !== "undefined") {
    return decodeWebAssets(__AI_1667_WEB_ASSETS__);
  }
  return await buildWebAssets();
}

/** Bundle `web/src/main.ts` for the browser and pair it with `web/index.html`.
 * Step 3 replaces this one function with a Vite build; nothing else here
 * (the embed, the caller, `host/web-server.ts`'s asset map) has to change. */
export async function buildWebAssets(): Promise<ReadonlyMap<string, WebAsset>> {
  const result = await Bun.build({
    entrypoints: [path.join(webRoot, "src", "main.ts")],
    target: "browser",
    format: "esm",
    minify: true
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(`1667 web asset build failed: ${result.logs.join("\n")}`);
  }
  const appJs = await result.outputs[0]!.text();
  const indexHtml = await readFile(path.join(webRoot, "index.html"), "utf8");
  return new Map<string, WebAsset>([
    ["/", { contentType: "text/html; charset=utf-8", body: new TextEncoder().encode(indexHtml) }],
    ["/app.js", { contentType: "text/javascript; charset=utf-8", body: new TextEncoder().encode(appJs) }]
  ]);
}
