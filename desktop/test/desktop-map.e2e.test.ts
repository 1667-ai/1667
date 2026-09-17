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

test("Electron Map: the stemma, an off-path focus, and the braid strip", { timeout: 180_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-map-e2e-"));
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
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Map story");
    await saveManualPart(page, "First part of the map story.");
    await saveManualPart(page, "Second part, first take.");

    // Two takes at ¶ 2: retake it, tag the retake ("keeper"), then switch
    // back to the first take so the tag ends up on the off-path node.
    await retakeSecondPart(page);
    await tagFocusedPart(page, "keeper");
    await switchTakeGaugeDot(page, 0, "take 1/2");

    await page.locator(".tab-map").click();
    await page.waitForSelector("svg.stemma", { timeout: 15_000 });
    const circles = await page.locator("svg.stemma circle.map-node").count();
    assert.ok(circles >= 3, `expected >= 3 circles in the stemma, got ${circles}`);

    // Click the accessible focus button for the off-path (tagged) take —
    // the same list the pre-stemma map exposed under `.map-focus`.
    const offPathFocus = page.locator(".map-focus", { hasText: /^focus$/u }).first();
    await offPathFocus.waitFor({ state: "visible", timeout: 15_000 });
    await offPathFocus.click();
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("take 2 of 2") === true, undefined, { timeout: 15_000 });

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".tab-content")?.classList.contains("write") === true, undefined, { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector(".breadcrumb")?.textContent?.includes("take 2 of 2") === true, undefined, { timeout: 15_000 });
    assert.equal(await page.locator(".manuscript-part").nth(1).evaluate((el) => el.classList.contains("focused")), true, "escape returns to Write at the same ¶");

    // Switch back to the untagged take so the braid strip has something to
    // show through ¶ 2 besides the current line.
    await switchTakeGaugeDot(page, 0, "take 1/2");

    await page.waitForSelector(".braid-strip", { timeout: 15_000 });
    assert.equal(await page.locator(".braid-ribbon").count(), 2, "your line plus the tagged line");
    await page.locator(".braid-ribbon-tag").click();
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Switched to keeper") === true, undefined, { timeout: 15_000 });
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

async function createStory(page: Page, title: string): Promise<void> {
  await goToLibrary(page);
  await page.locator(".new-story-button").click();
  await page.waitForSelector(".modal-card", { timeout: 15_000 });
  await page.locator(".modal-input").fill(title);
  await page.locator(".modal-submit").click();
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 15_000 });
}

async function saveManualPart(page: Page, text: string): Promise<void> {
  const before = await page.locator(".manuscript-part").count();
  await page.locator(".composer-input").fill(text);
  await page.locator(".composer-manual").click();
  await page.waitForFunction((expected) => document.querySelectorAll(".manuscript-part").length === expected, before + 1, { timeout: 15_000 });
}

async function retakeSecondPart(page: Page): Promise<void> {
  const second = page.locator(".manuscript-part").nth(1);
  await second.locator(".part-prose").click();
  await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[1]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });
  await second.locator(".part-retake").click();
  await page.waitForSelector(".stream-card", { timeout: 30_000 });
  await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
}

async function tagFocusedPart(page: Page, name: string): Promise<void> {
  await page.locator(".manuscript-part.focused .part-tag").click();
  const nameDialog = page.locator('.modal-card[aria-label="Line tag name"]');
  await nameDialog.waitFor({ state: "visible", timeout: 15_000 });
  await nameDialog.locator(".modal-input").fill(name);
  await nameDialog.locator(".modal-submit").click();
  const statusDialog = page.locator('.modal-card[aria-label="Line tag status"]');
  await statusDialog.waitFor({ state: "visible", timeout: 15_000 });
  await statusDialog.locator(".modal-submit").click();
  await page.waitForFunction((expected) => document.querySelector(".part-tag")?.textContent === `tag: ${expected}`, name, { timeout: 15_000 });
}

async function switchTakeGaugeDot(page: Page, dotIndex: number, expectTakeCount: string): Promise<void> {
  const retaken = page.locator(".manuscript-part.focused");
  await retaken.locator(".take-gauge-dot").nth(dotIndex).click();
  await page.waitForFunction(
    (expected) => document.querySelector(".manuscript-part.focused .part-take-count")?.textContent?.includes(expected) === true,
    expectTakeCount,
    { timeout: 15_000 }
  );
}
