import { fileURLToPath } from "node:url";
import type { WebAsset } from "../../host/web-server.js";

/**
 * The Vite build for `web/`, wrapped so `cli/src/web-assets.ts` only ever
 * reaches it through a non-literal `import()` (see there for why): this is
 * the one file in the compiled executable's own source graph that is
 * allowed a plain, static `import ... from "vite"` at the top, because it is
 * never itself part of that graph — it only exists to be loaded dynamically,
 * at runtime, from a source checkout.
 */
const configFile = fileURLToPath(new URL("../../web/vite.config.ts", import.meta.url));

/** The handful of output shapes this file reads off Vite's Rollup output —
 * kept local and minimal (matching `cli/test/standalone-worker-build.test.ts`'s
 * own local `Bun.build` result type) rather than importing Rollup's own
 * types, which Vite does not re-export under a single settled name across
 * versions. */
interface ViteOutputChunk {
  readonly type: "chunk";
  readonly fileName: string;
  readonly code: string;
  readonly moduleIds: readonly string[];
}

interface ViteOutputAsset {
  readonly type: "asset";
  readonly fileName: string;
  readonly source: string | Uint8Array;
}

type ViteOutputItem = ViteOutputChunk | ViteOutputAsset;

interface ViteBuildOutput {
  readonly output: readonly ViteOutputItem[];
}

export interface WebBuildResult {
  readonly assets: ReadonlyMap<string, WebAsset>;
  /** Every `node_modules` package name reached by the bundle — the web
   * analogue of `build-standalone.ts` verifying Bun's own metafile: the
   * Vite bundle enters the compiled executable as a define string, which
   * Bun's metafile cannot see into. */
  readonly bundledPackageNames: ReadonlySet<string>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  svg: "image/svg+xml"
};

function contentTypeFor(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  const contentType = CONTENT_TYPES[extension];
  if (contentType === undefined) {
    throw new Error(`1667 web build produced an asset with an unknown extension: ${fileName}`);
  }
  return contentType;
}

function assetPathFor(fileName: string): string {
  return fileName === "index.html" ? "/" : `/${fileName}`;
}

function bodyBytes(item: ViteOutputItem): Uint8Array {
  if (item.type === "chunk") return new TextEncoder().encode(item.code);
  return typeof item.source === "string" ? new TextEncoder().encode(item.source) : item.source;
}

/** `node_modules/<name>` for a scoped or unscoped package, from a Rollup
 * module id — which may carry a leading Rollup virtual-module `\0` marker
 * and/or a trailing `?query` (both observed from `@vitejs/plugin-react`'s
 * CommonJS interop, verified against Vite 8 / Bun 1.3.14), and may itself sit
 * inside a dependency's own nested `node_modules`. `lastIndexOf` picks the
 * innermost, and therefore correct, package boundary either way. */
function packageNameFromModuleId(moduleId: string): string | null {
  const marker = "/node_modules/";
  const markerIndex = moduleId.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  const rest = moduleId.slice(markerIndex + marker.length).split("?")[0]!;
  const segments = rest.split("/");
  const first = segments[0];
  if (first === undefined || first.length === 0) return null;
  if (first.startsWith("@")) {
    const second = segments[1];
    return second === undefined ? null : `${first}/${second}`;
  }
  return first;
}

export async function buildWebAssetsWithVite(): Promise<WebBuildResult> {
  const { build } = await import("vite");
  const result = await build({
    configFile,
    build: { write: false },
    logLevel: "warn"
  }) as ViteBuildOutput | readonly ViteBuildOutput[];
  const results: readonly ViteBuildOutput[] = Array.isArray(result) ? result : [result];
  const outputs = results.flatMap((one) => one.output);

  const assets = new Map<string, WebAsset>();
  const bundledPackageNames = new Set<string>();
  for (const item of outputs) {
    assets.set(assetPathFor(item.fileName), {
      contentType: contentTypeFor(item.fileName),
      body: bodyBytes(item)
    });
    if (item.type === "chunk") {
      for (const moduleId of item.moduleIds) {
        const packageName = packageNameFromModuleId(moduleId);
        if (packageName !== null) bundledPackageNames.add(packageName);
      }
    }
  }
  return { assets, bundledPackageNames };
}
