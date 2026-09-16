import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Phase 2b (theme surfaces) requires every color outside the token blocks to
// read a CSS custom property or a color-mix() of one. This guards against a
// raw hex or rgba() creeping back in and re-introducing a grey slab in a
// theme the author did not look at. See scratchpad/spec/02b-theme-surfaces.md.

const cssPath = join(dirname(fileURLToPath(import.meta.url)), "..", "renderer.css");
const LITERAL_COLOR = /rgba?\(|#[0-9a-fA-F]{3,8}\b/g;

// Strips every `:root { ... }` and `[data-desktop-theme...] { ... }` block
// (including the shared hi-contrast block), where literal colors are the
// theme's own token definitions and are explicitly allowed.
function stripTokenBlocks(css: string): string {
  return css.replace(/(?::root|\[data-desktop-theme[^\]]*\])\s*\{[^}]*\}/g, "");
}

test("renderer.css has no literal colors outside its token blocks", () => {
  const css = readFileSync(cssPath, "utf8");
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stripped = stripTokenBlocks(withoutComments);
  const matches = stripped.match(LITERAL_COLOR) ?? [];
  assert.deepEqual(matches, [], `found literal colors outside token blocks: ${matches.join(", ")}`);
});

test("stripTokenBlocks actually removes the theme blocks (sanity check)", () => {
  const css = readFileSync(cssPath, "utf8");
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stripped = stripTokenBlocks(withoutComments);
  assert.ok(!stripped.includes(":root {"), "the :root block must be stripped");
  assert.ok(!stripped.includes("[data-desktop-theme"), "theme blocks must be stripped");
  assert.ok(stripped.includes(".titlebar"), "the rest of the stylesheet must remain");
});
