/**
 * Load the photon image codec.
 *
 * `@silvia-odwyer/photon-node` is CommonJS, and its own top-level code loads
 * its WASM file with `readFileSync(join(__dirname, "photon_rs_bg.wasm"))`. A
 * compiled 1667 executable has no `node_modules` directory and no such file
 * on disk, so that call fails inside the compiled binary.
 *
 * The standalone build embeds the WASM bytes as a base64 define (see
 * `tui/scripts/standalone-build-requests.ts` and
 * `tui/scripts/build-standalone.ts`, next to the existing tiktoken define).
 * This loader feeds those bytes back through a temporary replacement of
 * `fs.readFileSync` that only intercepts a path ending in
 * `photon_rs_bg.wasm`, then restores the original function once photon has
 * read it. `server/openai-prompt-tokenizer.ts` follows the same
 * embed-and-restore shape for tiktoken.
 *
 * The import stays dynamic and runs only after the replacement is in place.
 * A static import would run photon's own `readFileSync` call first, before
 * this module had a chance to intercept it.
 */
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createRequire } from "node:module";
import type * as PhotonModule from "@silvia-odwyer/photon-node";

declare const __AI_1667_PHOTON_WASM_BASE64__: string | undefined;

export type Photon = typeof PhotonModule;

let cachedModule: Promise<Photon> | null = null;

/**
 * Load photon once and keep it. A decode that panics leaves the loaded
 * instance unsafe to reuse (see `server/image-normalize-child.ts`), which is
 * why 1667 normalizes at most one Source Image per process; within one
 * process, repeated successful calls share the same loaded module.
 */
export function loadPhoton(): Promise<Photon> {
  if (cachedModule === null) cachedModule = loadPhotonUncached();
  return cachedModule;
}

async function loadPhotonUncached(): Promise<Photon> {
  const wasmBytes = photonWasmBytes();
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = ((target: unknown, options: unknown) =>
    typeof target === "string" && target.endsWith("photon_rs_bg.wasm")
      ? wasmBytes
      : originalReadFileSync(target as never, options as never)) as typeof fs.readFileSync;
  try {
    const loaded: unknown = await import("@silvia-odwyer/photon-node");
    return ((loaded as { default?: Photon }).default ?? loaded) as Photon;
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
}

function photonWasmBytes(): Buffer {
  const embedded = typeof __AI_1667_PHOTON_WASM_BASE64__ === "string"
    ? __AI_1667_PHOTON_WASM_BASE64__
    : undefined;
  if (embedded !== undefined) return Buffer.from(embedded, "base64");
  const require = createRequire(import.meta.url);
  return fs.readFileSync(
    require.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm")
  );
}
