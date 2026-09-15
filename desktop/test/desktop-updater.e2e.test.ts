import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron } from "playwright";
import { DESKTOP_SHELL_EVENT_CHANNEL, type DesktopShellEvent } from "../shell-contract.js";
import { closeDesktopApp } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;
const require = createRequire(import.meta.url);

test("Mac updater panel offers the promoted version as a manual download", { timeout: 120_000 }, async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-updater-e2e-"));
  const { AI_1667_DESKTOP_DATA_DIR: _inheritedDataDir, ...inheritedEnv } = process.env;
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    cwd: directory,
    env: {
      ...inheritedEnv,
      AI_1667_STATE: path.join(directory, "machine"),
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    try {
      await page.waitForSelector(".launcher-page", { timeout: 30_000 });
    } catch (error) {
      const body = await page.locator("body").innerText().catch(() => "<body unavailable>");
      const startupScreenshot = process.env.AI_1667_DESKTOP_UPDATER_SCREENSHOT_PREFIX;
      if (startupScreenshot !== undefined) {
        await page.screenshot({ path: `${startupScreenshot}-startup-failure.png`, fullPage: true }).catch(() => undefined);
      }
      console.error(`Desktop updater startup body: ${body}`);
      throw error;
    }
    await page.waitForFunction(
      () => document.querySelector<HTMLSelectElement>(".updater-channel")?.disabled === false,
      undefined,
      { timeout: 15_000 }
    );
    await page.locator(".updater-channel").selectOption("beta");
    await page.waitForFunction(
      () => document.querySelector<HTMLSelectElement>(".updater-channel")?.value === "beta",
      undefined,
      { timeout: 15_000 }
    );
    const event: DesktopShellEvent = {
      type: "updaterState",
      state: {
        channel: "beta",
        manual: true,
        state: "available",
        version: "0.12.0-beta.2",
        message: null
      }
    };
    const screenshotPrefix = process.env.AI_1667_DESKTOP_UPDATER_SCREENSHOT_PREFIX;
    await app.evaluate(({ BrowserWindow }, input) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Desktop window is unavailable.");
      window.webContents.send(input.channel, input.event);
    }, { channel: DESKTOP_SHELL_EVENT_CHANNEL, event });

    const download = page.getByRole("button", { name: "Download update", exact: true });
    await download.waitFor({ state: "visible", timeout: 15_000 });
    assert.match(
      await page.locator(".updater-message").innerText(),
      /0\.12\.0-beta\.2.*save your work.*quit 1667.*replace the app manually/isu
    );
    assert.equal(await page.locator(".updater-channel").inputValue(), "beta");
    if (process.platform !== "darwin" && screenshotPrefix !== undefined) {
      await page.screenshot({ path: `${screenshotPrefix}-available.png`, fullPage: true });
    }

    if (process.platform === "darwin") {
      await page.locator(".updater-channel").selectOption("beta");
      await page.waitForFunction(
        () => document.querySelector(".updater-message")?.textContent?.includes("beta desktop update") === true,
        undefined,
        { timeout: 15_000 }
      );
      const openedUrlsKey = "__1667DesktopUpdaterOpenedUrls";
      await app.evaluate(({ shell }, key) => {
        const openedUrls: string[] = [];
        Reflect.set(globalThis, key, openedUrls);
        Reflect.set(shell, "openExternal", function (url: string): Promise<void> {
          openedUrls.push(url);
          return Promise.resolve();
        });
      }, openedUrlsKey);
      await app.evaluate(async function emitUpdate(
        _electron,
        input: { readonly modulePath: string; readonly version: string }
      ) {
        const moduleApi = process.getBuiltinModule("module");
        if (moduleApi === undefined) throw new Error("Node module loader is unavailable");
        const module = moduleApi.createRequire(input.modulePath)(input.modulePath) as {
          readonly autoUpdater?: { emit(event: string, value: unknown): void };
          readonly default?: { readonly autoUpdater?: { emit(event: string, value: unknown): void } };
        };
        const updater = module.autoUpdater ?? module.default?.autoUpdater;
        if (updater === undefined) throw new Error("electron-updater singleton is unavailable");
        updater.emit("update-available", { version: input.version });
      }, {
        modulePath: require.resolve("electron-updater"),
        version: "0.12.0-beta.2"
      });
      await download.waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(await page.locator(".updater-channel").inputValue(), "beta");
      if (screenshotPrefix !== undefined) {
        await page.screenshot({ path: `${screenshotPrefix}-available.png`, fullPage: true });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${screenshotPrefix}-available-narrow.png`, fullPage: true });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 900));
        await page.waitForTimeout(150);
      }
      await download.click();
      await page.waitForFunction(
        () => document.querySelector(".updater-message")?.textContent?.includes("release page") === true,
        undefined,
        { timeout: 15_000 }
      );
      const openedUrls = await app.evaluate((_electron, key: string) => Reflect.get(globalThis, key), openedUrlsKey);
      assert.deepEqual(openedUrls, ["https://github.com/1667-ai/1667/releases/tag/v0.12.0-beta.2"]);
      assert.equal(app.windows().length, 1, "manual Mac download must not close the app");
      if (screenshotPrefix !== undefined) {
        await page.screenshot({ path: `${screenshotPrefix}-after-click.png`, fullPage: true });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${screenshotPrefix}-after-click-narrow.png`, fullPage: true });
      }
    }
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});
