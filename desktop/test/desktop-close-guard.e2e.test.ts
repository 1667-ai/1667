import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron } from "playwright";
import { closeDesktopApp, editPart } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

test("Electron guards dirty close and reload with native Discard or Cancel", { timeout: 120_000 }, async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-close-guard-e2e-"));
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
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => undefined); });
    await page.waitForSelector(".story-title", { timeout: 30_000 });
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });

    const existingParts = await page.locator(".manuscript-part").count();
    await page.locator(".composer-input").fill("Saved base");
    await page.locator(".composer-manual").click();
    await page.waitForFunction((count) => document.querySelectorAll(".manuscript-part").length > count, existingParts, { timeout: 15_000 });
    const part = await editPart(page, "last");
    await part.fill("Unsaved native close draft");
    assert.match(await page.locator(".story-save-state").innerText(), /unsaved edits/iu);

    const cancelled = await chooseNativeClose(app, 1);
    assert.equal(cancelled.windows, 1);
    assert.deepEqual(cancelled.options.buttons, ["Discard", "Cancel"]);
    assert.equal(cancelled.options.cancelId, 1);
    assert.equal(await page.locator(".part-text").last().inputValue(), "Unsaved native close draft");

    const cancelledReload = await chooseNativeReload(app, 1);
    assert.equal(cancelledReload.options.cancelId, 1);
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".story-title").innerText(), "Start Here");
    assert.equal(await page.locator(".part-text").last().inputValue(), "Unsaved native close draft");
    await page.locator(".part-save").last().click();
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Saved") === true,
      undefined,
      { timeout: 15_000 }
    );

    const reopened = await editPart(page, "last");
    await reopened.fill("Quit retained native draft");
    const cancelledQuit = await chooseNativeQuit(app, 1);
    assert.equal(cancelledQuit.windows, 1);
    assert.equal(cancelledQuit.options.cancelId, 1);
    assert.equal(await page.locator(".part-text").last().inputValue(), "Quit retained native draft");
    await page.locator(".part-save").last().click();
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Saved") === true,
      undefined,
      { timeout: 15_000 }
    );

    await page.locator(".composer-input").fill("Second quit draft");
    const retriedQuit = await chooseNativeQuit(app, 1);
    assert.equal(retriedQuit.windows, 1);
    assert.equal(retriedQuit.options.cancelId, 1);
    assert.equal(await page.locator(".composer-input").inputValue(), "Second quit draft");

    await page.locator(".composer-input").fill("Discard this native close draft");
    const closed = page.waitForEvent("close", { timeout: 15_000 });
    const discarded = await chooseNativeClose(app, 0, true);
    assert.equal(discarded.options.buttons?.[0], "Discard");
    await closed;
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

async function chooseNativeClose(
  app: Awaited<ReturnType<typeof electron.launch>>,
  choice: 0 | 1,
  closeAfterEvaluate = false
): Promise<{ readonly windows: number; readonly options: MessageBoxOptions }> {
  if (choice === 0 && closeAfterEvaluate) {
    const prompt = await app.evaluate(async ({ BrowserWindow, dialog }) => {
      let options: MessageBoxOptions | undefined;
      dialog.showMessageBoxSync = ((...args: unknown[]) => {
        const nextOptions = (args.length > 1 ? args[1] : args[0]) as MessageBoxOptions;
        options = nextOptions;
        return 1;
      }) as typeof dialog.showMessageBoxSync;
      BrowserWindow.getAllWindows()[0]?.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        windows: BrowserWindow.getAllWindows().length,
        options: options ?? { buttons: [] }
      };
    });
    await app.evaluate(({ BrowserWindow, dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      setTimeout(() => BrowserWindow.getAllWindows()[0]?.close(), 50);
    });
    return prompt;
  }
  return await app.evaluate(async ({ BrowserWindow, dialog }, selected) => {
    let options: MessageBoxOptions | undefined;
    dialog.showMessageBoxSync = ((...args: unknown[]) => {
      const nextOptions = (args.length > 1 ? args[1] : args[0]) as MessageBoxOptions;
      options = nextOptions;
      return selected;
    }) as typeof dialog.showMessageBoxSync;
    BrowserWindow.getAllWindows()[0]?.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      windows: BrowserWindow.getAllWindows().length,
      options: options ?? { buttons: [] }
    };
  }, choice);
}

async function chooseNativeQuit(
  app: Awaited<ReturnType<typeof electron.launch>>,
  choice: 0 | 1
): Promise<{ readonly windows: number; readonly options: MessageBoxOptions }> {
  return await app.evaluate(async ({ app: electronApp, BrowserWindow, dialog }, selected) => {
    let options: MessageBoxOptions | undefined;
    dialog.showMessageBoxSync = ((...args: unknown[]) => {
      const nextOptions = (args.length > 1 ? args[1] : args[0]) as MessageBoxOptions;
      options = nextOptions;
      return selected;
    }) as typeof dialog.showMessageBoxSync;
    electronApp.quit();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      windows: BrowserWindow.getAllWindows().length,
      options: options ?? { buttons: [] }
    };
  }, choice);
}

async function chooseNativeReload(
  app: Awaited<ReturnType<typeof electron.launch>>,
  choice: 0 | 1
): Promise<{ readonly options: MessageBoxOptions }> {
  return await app.evaluate(async ({ BrowserWindow, dialog }, selected) => {
    let options: MessageBoxOptions | undefined;
    dialog.showMessageBoxSync = ((...args: unknown[]) => {
      const nextOptions = (args.length > 1 ? args[1] : args[0]) as MessageBoxOptions;
      options = nextOptions;
      return selected;
    }) as typeof dialog.showMessageBoxSync;
    BrowserWindow.getAllWindows()[0]?.webContents.reload();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { options: options ?? { buttons: [] } };
  }, choice);
}

interface MessageBoxOptions {
  readonly buttons?: readonly string[];
  readonly cancelId?: number;
}
