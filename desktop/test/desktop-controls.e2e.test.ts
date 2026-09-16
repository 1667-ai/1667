import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp, goToLibrary, openSettingsSection } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

// Phase 4a (scratchpad/spec/04-controls-settings-facts-chapters.md, §5) —
// scenarios 1-3. Scenarios 4-5 (Facts, Chapters) belong to phase 4b.

test("Electron controls: no range, checkbox, or switch anywhere in the renderer DOM", async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Controls proof");
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    await assertNoRawControls(page);
    await goToLibrary(page);
    await page.locator(".story-row").filter({ hasText: "Controls proof" }).click();
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "Controls proof", undefined, { timeout: 15_000 });
    await page.locator(".tab-facts").click();
    await page.waitForSelector(".tab-content.facts", { timeout: 15_000 });
    await assertNoRawControls(page);
    await page.locator(".tab-chapters").click();
    await page.waitForSelector(".tab-content.chapters", { timeout: 15_000 });
    await assertNoRawControls(page);
    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await assertNoRawControls(page);
  } finally {
    await teardown(app);
  }
});

test("Electron controls: the temperature scalar steps, flags invalid text, names the pending change, and discards", async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Scalar proof");
    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    // Temperature lives with the other sampling scalars (Settings › Sampling),
    // not Settings › Profiles as scenario 2 first assumed — see the report.
    await openSettingsSection(page, "sampling");

    const temperature = page.locator('[data-settings-field="profile.temperature"]');
    await temperature.waitFor({ state: "visible", timeout: 15_000 });
    const scalar = page.locator(".scalar").filter({ has: temperature });
    assert.equal(await temperature.inputValue(), "0.8", "the checked-in default profile ships temperature 0.8");

    await scalar.locator(".scalar-step-up").click();
    assert.equal(await temperature.inputValue(), "0.81", "one step up from 0.8 raises the value by the 0.01 step");

    await temperature.fill("abc");
    await page.waitForSelector(".scalar.invalid", { timeout: 15_000 });
    assert.equal(await temperature.inputValue(), "abc", "typing keeps the raw text even though it does not parse");

    const pendingText = await page.locator(".settings-pending-bar").innerText();
    assert.match(pendingText, /temperature/iu);
    assert.match(pendingText, /0\.81/u);

    await page.click(".settings-discard-draft");
    await page.waitForFunction(() => document.querySelector(".settings-discard-draft") === null, undefined, { timeout: 15_000 });
    assert.equal(await temperature.inputValue(), "0.8", "discarding the draft restores the original temperature");
  } finally {
    await teardown(app);
  }
});

test("Electron controls: a Desktop theme swatch sets the theme and its own type", async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Swatch proof");
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    await page.locator(".composer-input").fill("A line to measure the theme font against.");
    await page.locator(".composer-manual").click();
    await page.waitForSelector(".part-prose", { timeout: 15_000 });

    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await openSettingsSection(page, "desktop");
    await page.locator('.theme-swatch[data-theme="bond"]').click();
    await page.waitForFunction(() => document.documentElement.getAttribute("data-desktop-theme") === "bond", undefined, { timeout: 15_000 });

    await page.locator(".tab-write").click();
    await page.waitForSelector(".part-prose", { timeout: 15_000 });
    const fontFamily = await page.evaluate(() => getComputedStyle(document.querySelector(".part-prose")!).fontFamily);
    assert.match(fontFamily, /Georgia/u);
  } finally {
    await teardown(app);
  }
});

async function assertNoRawControls(page: Page): Promise<void> {
  const counts = await page.evaluate(() => ({
    range: document.querySelectorAll("input[type=range]").length,
    checkbox: document.querySelectorAll("input[type=checkbox]").length,
    switchRole: document.querySelectorAll("[role=switch]").length
  }));
  assert.deepEqual(counts, { range: 0, checkbox: 0, switchRole: 0 });
}

interface LaunchedApp {
  readonly app: import("playwright").ElectronApplication;
  readonly page: Page;
  readonly dataDir: string;
  readonly stateDir: string;
}

async function launch(): Promise<LaunchedApp> {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-controls-e2e-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-controls-state-e2e-"));
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(stateDir, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_STATE: stateDir,
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.waitForSelector(".new-story-button", { timeout: 30_000 });
  return { app, page, dataDir, stateDir };
}

async function teardown(launched: LaunchedApp): Promise<void> {
  await closeDesktopApp(launched.app);
  await rm(launched.dataDir, { recursive: true, force: true });
  await rm(launched.stateDir, { recursive: true, force: true });
}

async function createStory(page: Page, title: string): Promise<void> {
  await goToLibrary(page);
  await page.click(".new-story-button");
  await page.waitForSelector(".modal-card", { timeout: 15_000 });
  await page.fill(".modal-input", title);
  await page.click(".modal-submit");
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 15_000 });
}
