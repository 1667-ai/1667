import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Phase A (one type scale, one button hierarchy) replaces the stylesheet's
// mix of ad hoc pixel sizes with five tokens declared once on `:root`:
// --type-title, --type-record, --type-prose, --type-ui, --type-meta. This
// guards against a bespoke size creeping back in. See
// scratchpad/spec3/A-type-and-buttons.md.
//
// The test collects the *size* component of every `font-size:` declaration
// and every `font:` shorthand (ignoring an optional `/line-height`, which
// the five tokens do not govern), then asserts the set of distinct sizes is
// exactly the token set plus a short, named allow-list of genuine
// exceptions: brand/identity marks, marketing-scale hero headlines, a
// handful of serif "voice" fields sized between two tokens, quoted
// excerpts, and the map (its own later phase, not converted here).

const cssPath = join(dirname(fileURLToPath(import.meta.url)), "..", "renderer.css");

const TOKENS = new Set([
  "var(--type-title)",
  "var(--type-record)",
  "var(--type-prose)",
  "var(--prose-size)", // what --type-prose *is*; part-prose/stream-text/compare-* read it directly, unchanged
  "var(--type-ui)",
  "var(--type-meta)",
  "inherit"
]);

// Selector -> why it is not on the five-token scale.
const ALLOWED_EXCEPTIONS: Readonly<Record<string, string>> = {
  "18px": "brand-word — an identity wordmark, not a content heading",
  "27px": "launcher-name — an identity wordmark, not a content heading",
  "24px": "launcher-mark — a brand glyph, not text",
  "46px": "welcome h1 — the empty-library hero, above --type-title",
  "43px": "launcher-intro h1 (narrow media query) — hero headline",
  "clamp(38px, 6vw, 67px)": "launcher-intro h1 — the launcher's marketing-scale hero headline",
  "15px": "composer-input — a serif writing-voice field between --type-ui and --type-prose",
  "13px": "consistency-finding blockquote / finding-quote (quoted excerpts) and auth-prompt-message / launcher-auth-message (a short serif message line)",
  // The map is its own phase (00-common.md); not converted here.
  "8px": "map-dead-end-mark (SVG glyph, map phase)",
  "10px": "map-window-note / map-fact-anchor (map phase)",
  "11px": "map-list-label (map phase)"
};

const ALLOWED = new Set([...TOKENS, ...Object.keys(ALLOWED_EXCEPTIONS)]);

// Matches the size (and an optional /line-height, discarded) immediately
// before the trailing `var(--serif|sans|mono)` family in a `font:` shorthand.
const SIZE_BEFORE_FAMILY = /(clamp\([^)]*\)|var\(--[\w-]+\)|[\d.]+px)(?:\/(?:[\d.]+|var\(--[\w-]+\)))?\s+var\(--(?:serif|sans|mono)\)\s*(?:!important)?$/;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function collectFontSizes(css: string): string[] {
  const sizes: string[] = [];
  // `font-size: <value>;` — a plain declaration, never a shorthand.
  for (const match of css.matchAll(/(?<![\w-])font-size\s*:\s*([^;]+);/g)) {
    sizes.push(match[1]!.trim().replace(/\s*!important\s*$/, ""));
  }
  // `font: <...> <size>[/<line-height>] var(--serif|sans|mono);` shorthand.
  // `font: inherit;` has no family and no size to extract.
  for (const match of css.matchAll(/(?<![\w-])font\s*:\s*([^;]+);/g)) {
    const value = match[1]!.trim();
    if (value === "inherit") {
      sizes.push(value);
      continue;
    }
    const sizeMatch = SIZE_BEFORE_FAMILY.exec(value.replace(/\s*!important\s*$/, ""));
    assert.ok(sizeMatch !== null, `could not find a font-size in shorthand: "font: ${value};" — update the parser or the rule`);
    sizes.push(sizeMatch![1]!);
  }
  return sizes;
}

test("renderer.css font sizes are the five type-scale tokens, or a named exception", () => {
  const css = stripComments(readFileSync(cssPath, "utf8"));
  const sizes = collectFontSizes(css);
  assert.ok(sizes.length > 20, "sanity check: expected many font declarations in renderer.css");
  const unexpected = [...new Set(sizes)].filter((size) => !ALLOWED.has(size));
  assert.deepEqual(unexpected, [], `found font sizes outside the token set and allow-list: ${unexpected.join(", ")}`);
});

test("the five type tokens are declared on :root", () => {
  const css = readFileSync(cssPath, "utf8");
  for (const token of ["--type-title", "--type-record", "--type-prose", "--type-ui", "--type-meta"]) {
    assert.ok(css.includes(`${token}:`), `:root is missing ${token}`);
  }
});
