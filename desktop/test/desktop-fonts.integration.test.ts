import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The desktop names three families in its theme tokens. Before they were
// bundled, every platform without them installed fell back to a system face,
// so the designed type never reached a writer. These tests operate the
// stylesheet and the built application tree together, which is where that
// failure lived.

const DESKTOP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(path.join(DESKTOP_ROOT, "renderer.css"), "utf8");
const FAMILIES = ["IBM Plex Sans", "Literata", "JetBrains Mono"];

function fontFaceSources(): readonly string[] {
  return [...CSS.matchAll(/src:\s*url\("([^"]+)"\)/gu)].map((match) => match[1]!);
}

test("every family the themes name has a bundled face", () => {
  for (const family of FAMILIES) {
    assert.ok(
      new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*"${family}"`, "u").test(CSS),
      `${family} has no @font-face rule, so it falls back to a system font`
    );
  }
});

test("every bundled face resolves to a file that ships with the application", () => {
  const sources = fontFaceSources();
  assert.ok(sources.length >= 5, `expected the three families' faces, found ${sources.length}`);
  for (const source of sources) {
    assert.ok(source.startsWith("fonts/"), `${source} must sit beside the stylesheet`);
    assert.ok(
      existsSync(path.join(DESKTOP_ROOT, source)),
      `${source} is missing from desktop/${path.dirname(source)}`
    );
  }
});

test("the font directory carries its license", () => {
  const license = readFileSync(path.join(DESKTOP_ROOT, "fonts", "OFL.txt"), "utf8");
  assert.match(license, /SIL Open Font License/u);
  for (const holder of ["IBM Corp.", "Literata Project Authors", "JetBrains Mono Project Authors"]) {
    assert.ok(license.includes(holder), `${holder} is missing from the font license`);
  }
});

test("the built application tree carries the faces beside its stylesheet", { skip: !existsSync(path.join(DESKTOP_ROOT, "app", "renderer", "renderer.css")) }, () => {
  const built = path.join(DESKTOP_ROOT, "app", "renderer", "fonts");
  assert.ok(existsSync(built), "the build must copy desktop/fonts into app/renderer/fonts");
  const shipped = new Set(readdirSync(built));
  for (const source of fontFaceSources()) {
    assert.ok(shipped.has(path.basename(source)), `${source} is not in the built application tree`);
  }
});
