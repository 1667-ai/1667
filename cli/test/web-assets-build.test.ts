import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { loadWebAssets } from "../src/web-assets.js";

/** The built app is what a slow device downloads (#409). This test runs under
 * `bun test`, which sets NODE_ENV=test: the build must still be the small
 * production build. */
// The first load holds the shell, the Library, the manuscript, the composer,
// generation, and every action that a key, the palette or a menu can call at
// once (the editor, the notes, the chapters, the Facts, Aside, tags and
// imports), plus the palette, the search and the note and tag dialogs, which
// take typed text the moment a key opens them. The map, the settings page, the
// inspector pages, the panel views, the notice log and the Fact check and import
// dialogs download when a writer opens them (step 10m). The budget counts the
// scripts of the first load only: the entry script and the scripts it imports
// at once. The budget is the measured size (179 KB) plus about 10 percent.
const SCRIPT_BUDGET_GZIP_BYTES = 197 * 1024;

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
