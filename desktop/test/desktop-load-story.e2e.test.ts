import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

test("Electron keeps edits made while a story load is delayed", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-delayed-load-e2e-"));
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
    await createStory(page, "Load origin");
    await createStory(page, "Load destination");
    await selectStory(page, "Load origin");
    await installDelayedStoryLoad(page);
    await page.evaluate(() => {
      (window as Window & { __delayNextStoryLoad?: boolean }).__delayNextStoryLoad = true;
    });

    await page.locator(".story-row").filter({ hasText: "Load destination" }).click();
    await page.waitForFunction(
      () => document.querySelector(".topbar-status")?.textContent?.includes("Loading story") === true,
      undefined,
      { timeout: 15_000 }
    );
    const draft = "Typed while the destination story was loading.";
    await page.locator(".composer-input").fill(draft);
    await page.waitForFunction(
      () => document.querySelector(".topbar-status")?.textContent?.includes("newer edits kept") === true,
      undefined,
      { timeout: 30_000 }
    );
    assert.equal(await page.locator(".story-title").innerText(), "Load origin");
    assert.equal(await page.locator(".composer-input").inputValue(), draft);
    assert.match(await page.locator(".error-banner").innerText(), /retry/u);

    await page.locator(".story-row").filter({ hasText: "Load destination" }).click();
    const discard = page.locator('.modal-card[aria-label="Discard unsaved edits?"]');
    await discard.waitFor({ state: "visible", timeout: 15_000 });
    await discard.locator(".modal-submit").click();
    await page.waitForFunction(
      () => document.querySelector(".story-title")?.textContent === "Load destination",
      undefined,
      { timeout: 30_000 }
    );

    await page.evaluate(() => {
      (window as Window & { __delayNextStoryLoad?: boolean }).__delayNextStoryLoad = true;
    });
    await page.locator(".story-row").filter({ hasText: "Load origin" }).click();
    await page.waitForFunction(
      () => document.querySelector(".topbar-status")?.textContent?.includes("Loading story") === true,
      undefined,
      { timeout: 15_000 }
    );
    await page.locator(".story-row").filter({ hasText: "Load destination" }).click();
    await page.waitForFunction(
      () => document.querySelector(".story-title")?.textContent === "Load destination",
      undefined,
      { timeout: 15_000 }
    );
    await page.waitForTimeout(1_500);
    assert.equal(await page.locator(".story-title").innerText(), "Load destination");
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

async function installDelayedStoryLoad(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = window as Window & {
      __delayNextStoryLoad?: boolean;
      __delayedStoryLoadInstalled?: boolean;
    };
    if (runtime.__delayedStoryLoadInstalled === true) return;
    const postMessage = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message: unknown): void {
      const request = message as { readonly type?: unknown; readonly method?: unknown };
      if (runtime.__delayNextStoryLoad === true && request.type === "request" && request.method === "loadStory") {
        runtime.__delayNextStoryLoad = false;
        window.setTimeout(() => postMessage.call(this, message), 1_000);
        return;
      }
      postMessage.call(this, message);
    };
    runtime.__delayedStoryLoadInstalled = true;
  });
}

async function createStory(page: Page, title: string): Promise<void> {
  await page.locator(".new-story-button").click();
  await page.waitForSelector(".modal-card", { timeout: 15_000 });
  await page.locator(".modal-input").fill(title);
  await page.locator(".modal-submit").click();
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 30_000 });
}

async function selectStory(page: Page, title: string): Promise<void> {
  await page.locator(".story-row").filter({ hasText: title }).click();
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 30_000 });
}
