import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { loadWebAssets } from "../src/web-assets.js";

/** The built app is what a slow device downloads (#409). This test runs under
 * `bun test`, which sets NODE_ENV=test: the build must still be the small
 * production build. */
// The settings page (step 9b) brings the shared settings draft core into the
// bundle: the provider table, the capability rules and the draft reducers.
// The context meter (step 10f) brings the request projection into the bundle.
// Temporary headroom while features land; step 10m splits the routes and
// brings the first-load budget back down. The budget counts the scripts of the
// first load only: the entry script and the scripts it imports at once. A
// script loaded later by `import()` (the map, the prune review, the image
// thumbnails) is not downloaded until it is needed.
const SCRIPT_BUDGET_GZIP_BYTES = 230 * 1024;

/** The paths of the scripts the page loads at once: the ones its HTML names. */
function firstLoadScripts(html: string): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+\.js)"[^>]*>/g)) paths.add(match[1]!);
  return paths;
}

test("the served app script is the production build and stays small", async () => {
  expect(process.env.NODE_ENV).toBe("test");
  const assets = await loadWebAssets();
  const html = new TextDecoder().decode(assets.get("/")?.body ?? new Uint8Array());
  const first = firstLoadScripts(html);
  expect(first.size).toBeGreaterThan(0);
  const scripts = [...assets].filter(([path]) => path.endsWith(".js") && first.has(path));
  expect(scripts.length).toBe(first.size);
  let gzipBytes = 0;
  for (const [, asset] of scripts) {
    const source = new TextDecoder().decode(asset.body);
    expect(source).not.toContain("Download the React DevTools");
    gzipBytes += gzipSync(asset.body).byteLength;
  }
  expect(gzipBytes <= SCRIPT_BUDGET_GZIP_BYTES).toBeTrue();
}, 120_000);
