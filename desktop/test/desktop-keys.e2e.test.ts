import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp, goToLibrary } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;
const shortcut = process.platform === "darwin" ? "Meta" : "Control";

test("Electron reads the TUI keymap: focus, take switching, the keys sheet, and the palette", { timeout: 180_000 }, async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-keys-e2e-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_STATE: path.join(directory, "machine"),
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await goToLibrary(page);
    await page.locator(".new-story-button").click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.locator(".modal-input").fill("Keys and palette story");
    await page.locator(".modal-submit").click();
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "Keys and palette story", undefined, { timeout: 15_000 });
    await saveManualPart(page, "The first part of the keys story.");
    await saveManualPart(page, "The second part of the keys story.");

    await testFocusAndJump(page);
    await testRetakeAndTakeSwitching(page);
    await testLettersNeverActInFields(page);
    await testKeysSheet(page);
    await testPalette(page);
    await testDestinationLettersAndMapEscape(page);
    await testCopyPart(page);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

async function saveManualPart(page: Page, text: string): Promise<void> {
  const before = await page.locator(".manuscript-part").count();
  await page.locator(".composer-input").fill(text);
  await page.locator(".composer-manual").click();
  await page.waitForFunction((expected) => document.querySelectorAll(".manuscript-part").length === expected, before + 1, { timeout: 15_000 });
}

/** A single click on the prose focuses the part without entering edit mode
 * (double-click does that); it never steals keyboard focus into a field. */
async function clickPartLabel(page: Page, index: number): Promise<void> {
  await page.locator(".manuscript-part").nth(index).locator(".part-prose").click();
}

// 1. Click part 1 -> it is focused; ArrowDown -> part 2; g -> part 1; G -> part 2.
async function testFocusAndJump(page: Page): Promise<void> {
  await clickPartLabel(page, 0);
  await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 2, undefined, { timeout: 15_000 });
  assert.equal(await page.locator(".manuscript-part").nth(0).evaluate((el) => el.classList.contains("focused")), true);
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[1]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });
  await page.keyboard.press("g");
  await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[0]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });
  await page.keyboard.press("G");
  await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[1]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });
}

function breadcrumbText(page: Page): Promise<string> {
  return page.evaluate(() => [...document.querySelectorAll(".breadcrumb-segment")].map((el) => el.textContent ?? "").join(" | "));
}

// 2. r retakes (no dialog) the focused (leaf) part; the new take streams and
// finishes; ArrowLeft/ArrowRight walk the two takes.
async function testRetakeAndTakeSwitching(page: Page): Promise<void> {
  await page.keyboard.press("r");
  await page.waitForSelector(".stream-card", { timeout: 15_000 });
  await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
  await page.waitForFunction(() => /take 2 of 2/u.test(document.querySelector(".breadcrumb")?.textContent ?? ""), undefined, { timeout: 15_000 });
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => /take 1 of 2/u.test(document.querySelector(".breadcrumb")?.textContent ?? ""), undefined, { timeout: 15_000 });
  assert.match(await breadcrumbText(page), /take 1 of 2/u);
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => /take 2 of 2/u.test(document.querySelector(".breadcrumb")?.textContent ?? ""), undefined, { timeout: 15_000 });
  assert.match(await breadcrumbText(page), /take 2 of 2/u);
}

// 3. Letters never act inside a field: typing "r" into the composer types it.
async function testLettersNeverActInFields(page: Page): Promise<void> {
  const composer = page.locator(".composer-input");
  await composer.fill("");
  await composer.click();
  await page.keyboard.press("r");
  assert.equal(await composer.inputValue(), "r");
  assert.equal(await page.locator(".stream-card").count(), 0, "a plain 'r' inside the composer must not start a retake");
  await composer.fill("");
}

interface KeysRow { readonly keys: string; readonly description: string }

// 4. ? opens the keys sheet with the TUI's own wording; esc closes it.
async function testKeysSheet(page: Page): Promise<void> {
  await clickPartLabel(page, 0);
  await page.keyboard.press("?");
  await page.waitForSelector(".keys-sheet", { timeout: 15_000 });
  const rows: readonly KeysRow[] = await page.$$eval(".keys-sheet-row", (elements) => elements.map((el) => ({
    keys: el.querySelector(".keys-sheet-keys")?.textContent?.trim() ?? "",
    description: el.querySelector(".keys-sheet-description")?.textContent?.trim() ?? ""
  })));
  assert.ok(rows.some((row) => row.keys === "r" && row.description === "retake · same prompt"), "keys sheet must document r");
  assert.ok(rows.some((row) => row.keys === "u" && row.description === "undo break add · remove"), "keys sheet must document u");
  assert.ok(rows.some((row) => row.keys === "⌘K"), "the DESKTOP section must list ⌘K");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".keys-sheet", { state: "detached", timeout: 15_000 });
}

interface PaletteRow { readonly label: string; readonly key: string }

// 5. ⌘/Ctrl+K opens the palette; typing filters it; Enter runs the top match
// and closes; a running stream is the outermost escape layer (phase 3): the
// first escape stops it even under a reopened popover; the popover stays
// open until a second escape closes it.
async function testPalette(page: Page): Promise<void> {
  await page.keyboard.press(`${shortcut}+k`);
  await page.waitForSelector(".palette", { timeout: 15_000 });
  await page.locator(".palette-input").fill("reta");
  const rows: readonly PaletteRow[] = await page.$$eval(".palette-row", (elements) => elements.map((el) => ({
    label: el.querySelector(".palette-label")?.textContent?.trim() ?? "",
    key: el.querySelector(".palette-key")?.textContent?.trim() ?? ""
  })));
  assert.ok(rows.some((row) => row.label === "Retake this part" && row.key === "r"), "the palette must list Retake this part with key r");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".palette", { state: "detached", timeout: 15_000 });
  await page.waitForSelector(".stream-card", { timeout: 15_000 });

  await page.keyboard.press(`${shortcut}+k`);
  await page.waitForSelector(".palette", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
  assert.equal(await page.locator(".palette").count(), 1, "escape must stop the running stream first, leaving the popover open");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".palette", { state: "detached", timeout: 15_000 });
}

// 6. p / , / o / f / c / m reach their destinations; escape in Map returns to
// Write at the same focused part.
async function testDestinationLettersAndMapEscape(page: Page): Promise<void> {
  await page.keyboard.press(`${shortcut}+,`);
  await page.waitForSelector(".tab-content.settings", { timeout: 15_000 });
  const before = await page.locator(".directions-toggle").getAttribute("aria-pressed");
  await page.keyboard.press("p");
  await page.waitForFunction((expected) => document.querySelector(".directions-toggle")?.getAttribute("aria-pressed") !== expected, before, { timeout: 15_000 });

  await page.keyboard.press("o");
  await page.waitForSelector(".tab-content.library", { timeout: 15_000 });
  await page.keyboard.press("f");
  await page.waitForSelector(".tab-content.facts", { timeout: 15_000 });
  await page.keyboard.press("c");
  await page.waitForSelector(".tab-content.chapters", { timeout: 15_000 });

  await page.locator(".tab-write").click();
  await page.waitForSelector(".composer-input", { timeout: 15_000 });
  await clickPartLabel(page, 0);
  const focusedKey = await page.locator(".manuscript-part.focused").getAttribute("data-preserve");

  await page.keyboard.press("m");
  await page.waitForSelector(".tab-content.map", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".tab-content.write", { timeout: 15_000 });
  assert.equal(await page.locator(".manuscript-part.focused").getAttribute("data-preserve"), focusedKey, "Map's escape must return to Write at the same focused part");
}

// 7. y copies the focused part's text.
async function testCopyPart(page: Page): Promise<void> {
  await clickPartLabel(page, 0);
  const expected = await page.locator(".manuscript-part").nth(0).locator(".part-prose").innerText();
  await page.keyboard.press("y");
  const clipboard = await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  });
  if (clipboard !== null) {
    assert.equal(clipboard, expected);
  } else {
    await page.waitForFunction(() => /Copied ¶ 1/u.test(document.querySelector(".toast")?.textContent ?? ""), undefined, { timeout: 15_000 });
  }
}
