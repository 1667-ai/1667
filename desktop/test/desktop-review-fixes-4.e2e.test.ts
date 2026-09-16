/** Regression coverage for the phase 9 review-fixes brief
 * (scratchpad/spec/09-review-fixes-4.md): one Electron launch per `test()`,
 * grouping scenarios that touch the same area. Every scenario here was
 * confirmed to fail against the pre-fix code for the reason named in its
 * comment before the corresponding fix landed. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp, editPart, goToLibrary } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-review-fixes-4-e2e-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-review-fixes-4-state-e2e-"));
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

async function saveManualPart(page: Page, text: string): Promise<void> {
  const before = await page.locator(".manuscript-part").count();
  await page.locator(".composer-input").fill(text);
  await page.locator(".composer-manual").click();
  await page.waitForFunction((expected) => document.querySelectorAll(".manuscript-part").length === expected, before + 1, { timeout: 15_000 });
}

async function focusPart(page: Page, index: number): Promise<void> {
  await page.locator(".manuscript-part").nth(index).locator(".part-prose").click();
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".manuscript-part")[expected]?.classList.contains("focused") === true,
    index,
    { timeout: 15_000 }
  );
}

// Finding 2: continuing from an explicit earlier seam must check that part's
// own draft, not the leaf's — otherwise the manuscript shows the edit while
// the provider still receives the part's older saved text.
test("Electron review fixes 4: Continue from an earlier part with an unsaved draft is blocked", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Earlier-seam dirty-draft proof");
    await saveManualPart(page, "The first part of the earlier-seam story.");
    await saveManualPart(page, "The second part of the earlier-seam story.");
    await saveManualPart(page, "The third part of the earlier-seam story.");

    const editor = await editPart(page, 0);
    const original = await editor.inputValue();
    await editor.fill(`${original} EDITED`);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".part-text", { state: "detached", timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[0]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });

    await page.keyboard.press("Space");
    await page.waitForSelector(".error-banner", { timeout: 15_000 });
    assert.match(await page.locator(".error-banner").innerText(), /save it before generating/iu);
    const streamStarted = await page.locator(".stream-card").waitFor({ state: "visible", timeout: 1_500 }).then(() => true).catch(() => false);
    assert.equal(streamStarted, false, "Space must not start a stream while the target part has an unsaved draft");
  } finally {
    await teardown(app);
  }
});

// Finding 3: a manual append with no write target must move focus to the
// part it just created, so the next Continue builds on it instead of the
// part that used to be focused.
test("Electron review fixes 4: a manual append moves focus to the new part", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Manual append focus proof");
    await saveManualPart(page, "The first part of the manual append focus story.");
    await saveManualPart(page, "The second part of the manual append focus story.");

    await focusPart(page, 0);
    await page.locator(".composer-input").fill("A manually written line.");
    await page.locator(".composer-manual").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 3, undefined, { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[2]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });
  } finally {
    await teardown(app);
  }
});

// Finding 6: the placeholder and the empty submit label both advertise
// "Empty ↵ continues"; plain Enter on an empty Continue composer must
// actually submit it, while Shift+Enter (and Enter once text is typed) must
// keep inserting a newline.
test("Electron review fixes 4: empty Enter continues; Shift+Enter still inserts a newline", { timeout: 180_000 }, async () => {
  const app = await launch();
  try {
    const page = app.page;
    await createStory(page, "Empty Enter continues proof");
    await saveManualPart(page, "The only part of the empty Enter story.");

    const composer = page.locator(".composer-input");
    await composer.click();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });

    await composer.click();
    await composer.fill("A direction with a newline.");
    await page.keyboard.press("Shift+Enter");
    await page.waitForFunction(
      () => (document.querySelector(".composer-input") as HTMLTextAreaElement | null)?.value.includes("\n") === true,
      undefined,
      { timeout: 15_000 }
    );
    const streamStarted = await page.locator(".stream-card").waitFor({ state: "visible", timeout: 1_500 }).then(() => true).catch(() => false);
    assert.equal(streamStarted, false, "Shift+Enter must insert a newline, not submit the composer");
  } finally {
    await teardown(app);
  }
});
