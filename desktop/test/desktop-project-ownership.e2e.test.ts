import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { createWorkerHost } from "../../host/worker-host.js";
import type { StoryApi } from "../../client/api.js";

declare global {
  interface Window {
    ownershipApi: StoryApi;
    ownershipReady: boolean;
    ownershipError?: string;
  }
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(
    () => window.ownershipReady || window.ownershipError,
    undefined,
    { timeout: 30_000 }
  );
  assert.equal(await page.evaluate(() => window.ownershipError), undefined);
}

test("two windows keep project ownership while the last Host owner releases its lock", { timeout: 120_000 }, async () => {
  const appPath = process.env.AI_1667_DESKTOP_APP_PATH;
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-ownership-"));
  const dataDir = path.join(directory, "project");
  const secondRoot = path.join(directory, "second-project");
  const machineDir = path.join(directory, "machine");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const fixture = path.join(directory, "index.html");
  await writeFile(
    fixture,
    '<!doctype html><meta charset="utf-8"><title>Desktop ownership</title>'
      + '<script type="module" src="./ownership.js"></script>'
  );
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/desktop-ownership.ts", import.meta.url))],
    outfile: path.join(directory, "ownership.js"),
    bundle: true,
    platform: "browser",
    format: "esm"
  });
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    ...(process.env.AI_1667_DESKTOP_EXECUTABLE === undefined
      ? {}
      : { executablePath: process.env.AI_1667_DESKTOP_EXECUTABLE }),
    env: {
      ...process.env,
      AI_1667_STATE: machineDir,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_DESKTOP_RENDERER_URL: pathToFileURL(fixture).href,
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  let reopened: Awaited<ReturnType<typeof createWorkerHost>> | undefined;
  try {
    const first = await app.firstWindow();
    await ready(first);
    const secondWindow = app.waitForEvent("window");
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
      const item = file?.submenu?.items.find((candidate) => candidate.label === "New Window");
      if (item?.click === undefined) throw new Error("New Window menu item is missing");
      item.click(item, null, null);
    });
    const second = await secondWindow;
    await ready(second);

    const seeded = await first.evaluate(async () => await window.ownershipApi.createStory("Shared Host"));
    const loaded = await second.evaluate(async (id) => await window.ownershipApi.loadStory(id), seeded.id);
    assert.equal(loaded.title, "Shared Host");

    const switched = await first.evaluate(async (root) =>
      await window.desktop?.shell?.request({ type: "project.create", root }), secondRoot);
    assert.ok(switched);
    assert.equal(switched.ok, true);

    const renamed = await second.evaluate(
      async (id) => await window.ownershipApi.renameStory(id, "B still owns the first project"),
      seeded.id
    );
    assert.equal(renamed.title, "B still owns the first project");

    await assert.rejects(
      () => createWorkerHost({ dataDir, machineDir }),
      /already open|already in use|locked|busy/i
    );

    await first.bringToFront();
    const thirdWindow = app.waitForEvent("window");
    await openNewWindowFromPage(app, first);
    const third = await thirdWindow;
    await ready(third);
    const focusedProjectStory = await third.evaluate(
      async () => await window.ownershipApi.createStory("Focused project")
    );
    const originalProjectStories = await second.evaluate(
      async () => await window.ownershipApi.listStories()
    );
    assert.equal(
      originalProjectStories.some((story) => story.id === focusedProjectStory.id),
      false
    );
    await third.close();

    await second.close();
    const deadline = Date.now() + 10_000;
    while (reopened === undefined) {
      try {
        reopened = await createWorkerHost({ dataDir, machineDir });
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  } finally {
    await reopened?.dispose();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function openNewWindowFromPage(app: ElectronApplication, page: Page): Promise<void> {
  const nativeWindow = await app.browserWindow(page);
  try {
    const preferredWindowId = await nativeWindow.evaluate((window) => window.id);
    await app.evaluate(async ({ app, BrowserWindow, Menu }, targetWindowId) => {
      const target = BrowserWindow.fromId(targetWindowId);
      if (target === null) throw new Error(`Window ${targetWindowId} is unavailable`);
      app.focus({ steal: true });
      target.show();
      target.focus();
      target.moveTop();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const focused = BrowserWindow.getFocusedWindow();
        if (focused === null || focused.id === targetWindowId) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
        target.focus();
      }
      const focused = BrowserWindow.getFocusedWindow();
      if (focused !== null && focused.id !== targetWindowId) {
        throw new Error(`Window ${focused.id} kept focus instead of ${targetWindowId}`);
      }
      const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
      const item = file?.submenu?.items.find((candidate) => candidate.label === "New Window");
      if (item?.click === undefined) throw new Error("New Window menu item is missing");
      // Invoke the menu in this main-process turn. openNewWindow captures the
      // focused window before its first await, so a focusless display falls
      // back to the first valid session without a stale-window race.
      item.click(item, null, null);
    }, preferredWindowId);
  } finally {
    await nativeWindow.dispose();
  }
}
