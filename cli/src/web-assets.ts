import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebAsset } from "../../host/web-server.js";
import { decodeWebAssets, encodeWebAssets, type EncodedWebAsset } from "./web-assets-codec.js";

/** A compiled build embeds the built assets under this identifier
 * (`cli/scripts/standalone-build-requests.ts`'s `define`), the same pattern
 * `worker-transport.ts`'s `__AI_1667_EMBEDDED_WORKER_SOURCE__` uses: `Bun.build`'s
 * `define` splices the `JSON.stringify`d value in as source text, so an
 * object value becomes a literal object expression here, not a string to
 * re-parse. It carries `EncodedWebAsset` entries (base64 bodies), not
 * `WebAsset` directly — see `cli/src/web-assets-codec.ts`. */
declare const __AI_1667_WEB_ASSETS__: Readonly<Record<string, EncodedWebAsset>> | undefined;

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const cacheDirectory = path.join(repositoryRoot, "node_modules", ".cache", "1667-web");
/** Inputs that change what the build produces. Not `web/dist` — that is the
 * build's own output, not an input, and does not exist in this repository
 * anyway (Vite always runs with `build.write: false` here). `web/vite.config.ts`
 * is already covered by the `web` directory below; `web-build.ts` is not —
 * it lives under `cli/scripts`. */
const HASHED_DIRECTORIES = ["web", "client", "shared"];
const HASHED_FILES = ["package-lock.json", "cli/scripts/web-build.ts"];
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", "dist", ".git"]);
/** How many cached builds `writeCache` keeps: enough for a few content
 * hashes in flight across parallel test runs, small enough that a stale
 * cache directory does not grow without bound. */
const MAX_CACHED_BUILDS = 5;

/**
 * The app bundle's static files, served publicly by `host/web-server.ts`:
 * the shell page (`"/"`) and one hashed `/assets/*` entry per Vite output
 * chunk, including binary fonts. A compiled `1667` has no `web/` directory
 * to build these from at runtime, so it always embeds them
 * (`cli/scripts/build-standalone.ts`); a source run (`bun src/standalone.ts`,
 * or this repo's own tests) builds them on demand instead, behind a
 * content-hash cache — Vite's own build is too slow to repeat on every test
 * spawn in the same run.
 */
export async function loadWebAssets(): Promise<ReadonlyMap<string, WebAsset>> {
  if (typeof __AI_1667_WEB_ASSETS__ !== "undefined") {
    return decodeWebAssets(__AI_1667_WEB_ASSETS__);
  }
  return await buildWebAssets();
}

/** Build with Vite, or reuse a build already cached under the current
 * content hash of every input the build depends on. Not exported: nothing
 * outside this module reaches it directly — `loadWebAssets` above is the
 * cached path a source run uses, and a packaged build's own fresh build goes
 * through `cli/scripts/build-standalone.ts` calling `buildWebAssetsWithVite`
 * (`cli/scripts/web-build.ts`) itself, bypassing this cache entirely. */
async function buildWebAssets(): Promise<ReadonlyMap<string, WebAsset>> {
  const hash = await hashWebInputs();
  const cacheFile = path.join(cacheDirectory, `${hash}.json`);
  const cached = await readCache(cacheFile);
  if (cached !== null) return decodeWebAssets(cached);

  // A non-literal specifier: `bun --compile` (`cli/scripts/build-standalone.ts`)
  // must never see a static edge from this module — which the compiled
  // executable's own source graph includes — to `vite`, which it does not
  // ship. A compiled executable never actually reaches this line (its
  // `__AI_1667_WEB_ASSETS__` define is always defined, so `loadWebAssets`
  // returns above), but keeping the import non-literal, plus the "vite"
  // `external` entry in `cli/scripts/standalone-build-requests.ts`, means
  // that stays true even if Bun's bundler tries to resolve it anyway.
  const builderUrl = new URL("../scripts/web-build.js", import.meta.url).href;
  const builder = await import(/* @vite-ignore */ builderUrl) as
    typeof import("../scripts/web-build.js");
  const { assets } = await builder.buildWebAssetsWithVite();
  await writeCache(cacheFile, encodeWebAssets(assets));
  return assets;
}

async function hashWebInputs(): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];
  for (const directory of HASHED_DIRECTORIES) {
    files.push(...await filesUnder(path.join(repositoryRoot, directory)));
  }
  for (const file of HASHED_FILES) files.push(path.join(repositoryRoot, file));
  files.sort();
  for (const file of files) {
    hash.update(path.relative(repositoryRoot, file).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

async function readCache(cacheFile: string): Promise<Readonly<Record<string, EncodedWebAsset>> | null> {
  try {
    return JSON.parse(await readFile(cacheFile, "utf8")) as Record<string, EncodedWebAsset>;
  } catch {
    return null;
  }
}

/** Write to a temp file, then rename over the final name: two parallel test
 * spawns racing on the same content hash must never observe a partially
 * written cache file, and the loser's write must not corrupt the winner's. */
async function writeCache(
  cacheFile: string,
  encoded: Readonly<Record<string, EncodedWebAsset>>
): Promise<void> {
  await mkdir(cacheDirectory, { recursive: true });
  const tempFile = path.join(
    cacheDirectory,
    `.${path.basename(cacheFile)}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
  );
  await writeFile(tempFile, JSON.stringify(encoded));
  await rename(tempFile, cacheFile);
  await pruneCache();
}

/** Keeps only the `MAX_CACHED_BUILDS` most recently written cache files —
 * every source checkout that ever changes `web/`, `client/`, or `shared/`
 * mints a new content hash, and an old one is never read again once nothing
 * on disk still hashes to it. Best-effort: a prune failure (another process
 * mid-write, a file removed between `readdir` and `stat`) must not fail the
 * build whose cache entry was just written successfully. */
async function pruneCache(): Promise<void> {
  try {
    const entries = await readdir(cacheDirectory, { withFileTypes: true });
    const cacheFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    const withMtime = await Promise.all(cacheFiles.map(async (entry) => {
      const filePath = path.join(cacheDirectory, entry.name);
      try {
        return { filePath, mtimeMs: (await stat(filePath)).mtimeMs };
      } catch {
        return null;
      }
    }));
    const sorted = withMtime
      .filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== null)
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    await Promise.all(sorted.slice(MAX_CACHED_BUILDS).map(async ({ filePath }) => {
      try {
        await unlink(filePath);
      } catch {
        // Another process may have already removed or replaced it.
      }
    }));
  } catch {
    // No cache directory yet, or a transient read error: nothing to prune.
  }
}
