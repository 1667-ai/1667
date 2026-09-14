import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { _electron as electron, type Page } from "playwright";
import type {} from "./fixtures/client-contract.js";
import { MutationOutbox } from "../../server/mutation-outbox.js";

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.contractReady || window.contractError, undefined, { timeout: 30_000 });
  assert.equal(await page.evaluate(() => window.contractError), undefined);
}

test("the sandboxed Desktop Transport runs the client contract and fences stale windows", { timeout: 120_000 }, async () => {
  const appPath = process.env.AI_1667_DESKTOP_APP_PATH;
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-contract-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const fixture = path.join(directory, "index.html");
  await writeFile(fixture, '<!doctype html><meta charset="utf-8"><title>Desktop client contract</title><script type="module" src="./contract.js"></script>');
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/client-contract.ts", import.meta.url))],
    outfile: path.join(directory, "contract.js"), bundle: true, platform: "browser", format: "esm"
  });
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    ...(process.env.AI_1667_DESKTOP_EXECUTABLE === undefined ? {}
      : { executablePath: process.env.AI_1667_DESKTOP_EXECUTABLE }),
    env: {
      ...process.env,
      AI_1667_STATE: path.join(directory, "machine"),
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_DESKTOP_RENDERER_URL: pathToFileURL(fixture).href,
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const first = await app.firstWindow();
    await ready(first);
    await first.evaluate(() => window.runClientContract());
    const { story, chapter } = await first.evaluate(async () => {
      const api = window.contractApi;
      const created = await api.createStory("Two windows");
      const story = await api.createNode(created.id, { parentId: null, text: "Two windows share this story." });
      const chapter = await api.createChapterBreak(story.id, story.path[0]!.id, "Shared chapter");
      return { story, chapter };
    });
    const secondWindow = app.waitForEvent("window");
    await first.bringToFront();
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
      const item = file?.submenu?.items.find((entry) => entry.label === "New Window");
      if (item === undefined) throw new Error("File > New Window is unavailable");
      Reflect.apply(item.click, item, []);
    });
    const second = await secondWindow;
    await ready(second);
    const libraryIds = await first.evaluate(async () => {
      const rename = await window.contractApi.createStory("Library rename");
      const remove = await window.contractApi.createStory("Library delete");
      return [rename.id, remove.id] as const;
    });
    await second.evaluate(() => window.contractApi.listStories());
    await first.evaluate(async (ids) => {
      for (const id of ids) await window.contractApi.renameStory(id, "New catalog revision");
    }, libraryIds);
    await second.evaluate(async ([rename, remove]) => {
      await window.contractApi.listStories();
      await window.contractApi.renameStory(rename, "Renamed without opening");
      await window.contractApi.deleteStory(remove);
    }, libraryIds);
    await second.evaluate((id) => window.contractApi.loadStory(id), story.id);
    await first.evaluate((id) => window.contractApi.renameStory(id, "First window's title"), story.id);
    const staleCode = await second.evaluate(async (id) => {
      await window.contractApi.listStories();
      try {
        await window.contractApi.renameStory(id, "Stale title");
        return "unexpected_success";
      } catch (error) {
        return (error as { code?: string }).code;
      }
    }, story.id);
    assert.equal(staleCode, "revision_conflict");
    const staleReads = await second.evaluate(async ({ id, chapterId }) => {
      const codes: (string | undefined)[] = [];
      for (const operation of [
        () => window.contractApi.autonameStory(id),
        () => window.contractApi.removeChapterBreak(id, chapterId)
      ]) {
        try { await operation(); codes.push("unexpected_success"); }
        catch (error) { codes.push((error as { code?: string }).code); }
      }
      return codes;
    }, { id: story.id, chapterId: chapter.breakId });
    assert.deepEqual(staleReads, ["revision_conflict", "revision_conflict"]);
    assert.equal((await second.evaluate((id) => window.contractApi.loadStory(id), story.id)).title,
      "First window's title");
    await second.evaluate((id) => window.contractApi.renameStory(id, "Adopted title"), story.id);
    await second.evaluate(() => window.setFailingProvider(true));
    const failure = await second.evaluate(async (id) => {
      try { await window.contractApi.autonameStory(id); return "unexpected_success"; }
      catch (error) { return (error as { code?: string }).code; }
    }, story.id);
    assert.equal(failure, "provider_failure");
    await first.evaluate(async (id) => {
      await window.contractApi.loadStory(id);
      await window.contractApi.renameStory(id, "After provider failure");
    }, story.id);
    const afterFailure = await second.evaluate(async (id) => {
      try { await window.contractApi.renameStory(id, "Stale after failure"); return "unexpected_success"; }
      catch (error) { return (error as { code?: string }).code; }
    }, story.id);
    assert.equal(afterFailure, "revision_conflict");
    await second.evaluate(() => window.setFailingProvider(false));
    await first.evaluate(async (id) => {
      const story = await window.contractApi.loadStory(id);
      void window.contractApi.continueStory(id, "Reload during this generation.", "desktop-reload-contract",
        { parentId: story.path.at(-1)!.id }, () => { window.contractStreaming = true; },
        new AbortController().signal).catch(() => {});
    }, story.id);
    await first.waitForFunction(() => window.contractStreaming, undefined, { timeout: 10_000 });
    await first.reload();
    await ready(first);
    assert.equal((await first.evaluate((id) => window.contractApi.loadStory(id), story.id)).title, "After provider failure");
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    const deadline = Date.now() + 10_000;
    while ((await outbox.list()).length > 0) {
      assert.ok(Date.now() < deadline, "Renderer reload left a pending Host mutation");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
