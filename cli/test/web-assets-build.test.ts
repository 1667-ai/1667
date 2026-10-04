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
// brings the first-load budget back down.
const SCRIPT_BUDGET_GZIP_BYTES = 230 * 1024;

test("the served app script is the production build and stays small", async () => {
  expect(process.env.NODE_ENV).toBe("test");
  const assets = await loadWebAssets();
  const scripts = [...assets].filter(([path]) => path.endsWith(".js"));
  expect(scripts.length).toBeGreaterThan(0);
  let gzipBytes = 0;
  for (const [, asset] of scripts) {
    const source = new TextDecoder().decode(asset.body);
    expect(source).not.toContain("Download the React DevTools");
    gzipBytes += gzipSync(asset.body).byteLength;
  }
  expect(gzipBytes <= SCRIPT_BUDGET_GZIP_BYTES).toBeTrue();
}, 120_000);
