import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp, editPart, goToLibrary, openSettingsSection } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

test("Electron guards active generation, seal cancellation, and display choices", async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-navigation-e2e-"));
  const dataDir = path.join(directory, ".1667");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_STATE: path.join(directory, "machine"),
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Active generation");
    await createStory(page, "Other story");
    await selectStory(page, "Active generation");
    await page.locator(".composer-input").fill("A saved line anchors the active story.");
    await page.locator(".composer-manual").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });

    await openPartMenuAndClick(page, 0, ".summary-take");
    await page.waitForSelector(".stream-card", { timeout: 15_000 });
    await page.waitForFunction(
      () => (document.querySelector(".stream-text")?.textContent?.length ?? 0) > 8,
      undefined,
      { timeout: 15_000 }
    );
    await page.locator(".stream-stop").click();
    await page.waitForSelector(".stopped-generation", { timeout: 30_000 });

    await goToLibrary(page);
    await page.locator(".project-browser").click();
    await page.waitForSelector(".launcher-page", { timeout: 15_000 });
    await page.waitForSelector(".recent-project", { timeout: 15_000 });
    await page.locator(".recent-project").first().click();
    await page.waitForFunction(
      () => document.querySelector(".launcher-error")?.textContent?.includes("Discard the interrupted summary") === true,
      undefined,
      { timeout: 15_000 }
    );
    await page.getByRole("button", { name: "Back to story" }).click();
    await page.locator(".tab-write").click();
    await page.waitForSelector(".stopped-discard", { timeout: 15_000 });
    await page.locator(".stopped-discard").click();
    await page.waitForSelector(".stopped-generation", { state: "detached", timeout: 15_000 });

    await page.locator(".composer-submit").click();
    await page.waitForSelector(".stream-card", { timeout: 15_000 });

    await goToLibrary(page);
    await page.locator(".story-row").filter({ hasText: "Other story" }).click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".story-title").innerText(), "Active generation");
    const cancel = page.locator(".modal-cancel");
    if (await cancel.count() > 0) await cancel.click();
    assert.equal(await page.locator(".story-title").innerText(), "Active generation");
    // .stream-card only renders on the Write tab now; check it there, or a
    // still-active background stream reads as already finished on Library.
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector(".stream-card") === null, undefined, { timeout: 30_000 });
    assert.ok(await page.locator(".manuscript-part").count() > 0);

    await selectStory(page, "Other story");
    assert.equal(await page.locator(".manuscript-part").count(), 0);

    await selectStory(page, "Active generation");
    const part = await editPart(page, "last");
    await part.fill("Unsaved part text");
    await page.locator(".composer-input").fill("Unsaved composer direction");

    await goToLibrary(page);
    await page.locator(".project-browser").click();
    await page.waitForSelector(".launcher-page", { timeout: 15_000 });
    assert.equal(await page.getByRole("button", { name: "Back to story" }).count(), 1);
    assert.equal(await page.locator(".account-panel").count(), 1);
    assert.equal(await page.locator(".updater-panel").count(), 1);
    assert.equal(await page.getByRole("button", { name: "Reveal folder" }).count(), 1);
    await page.getByRole("button", { name: "Back to story" }).click();
    await page.waitForSelector(".story-title", { timeout: 15_000 });
    assert.equal(await page.locator(".story-title").innerText(), "Active generation");
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    assert.equal(await page.locator(".part-text").last().inputValue(), "Unsaved part text");
    assert.equal(await page.locator(".composer-input").inputValue(), "Unsaved composer direction");

    await goToLibrary(page);
    await page.locator(".project-seal").click();
    await page.waitForSelector('.modal-card[aria-label="Discard unsaved edits?"]', { timeout: 15_000 });
    await page.locator(".modal-cancel").click();
    await page.waitForSelector(".modal-card", { state: "detached", timeout: 15_000 });
    assert.equal(await page.locator(".launcher-page").count(), 0);
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    assert.equal(await page.locator(".part-text").last().inputValue(), "Unsaved part text");
    assert.equal(await page.locator(".composer-input").inputValue(), "Unsaved composer direction");

    // The native reload guard has its own Electron test. Clear these drafts
    // before this test reloads to verify display choices.
    await page.locator(".part-save").last().click();
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Saved") === true,
      undefined,
      { timeout: 15_000 }
    );
    await page.locator(".composer-input").fill("");

    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await openSettingsSection(page, "output");
    const settingsDraft = page.locator('[data-settings-field="profile.maxOutputTokens"]');
    await settingsDraft.fill("654");
    await goToLibrary(page);
    await page.locator(".project-browser").click();
    await page.waitForSelector(".launcher-page", { timeout: 15_000 });
    await page.waitForSelector(".recent-project", { timeout: 15_000 });
    await page.locator(".recent-project").first().click();
    const discardDialog = page.locator('.modal-card[aria-label="Discard unsaved edits?"]');
    await discardDialog.waitFor({ state: "visible", timeout: 15_000 });
    assert.match(await discardDialog.innerText(), /settings/u);
    await discardDialog.locator(".modal-submit").click();
    await page.waitForSelector(".story-title", { timeout: 30_000 });
    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 30_000 });
    await page.waitForFunction(
      () => (document.querySelector('[data-settings-field="profile.maxOutputTokens"]') as HTMLInputElement | null)?.value !== "654",
      undefined,
      { timeout: 30_000 }
    );

    await openSettingsSection(page, "desktop");
    await page.locator('.theme-swatch[data-theme="graphite"]').click();
    const directions = page.locator(".directions-toggle");
    await directions.click();
    const directionsAfterChange = await directions.getAttribute("aria-pressed");
    await page.reload();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 30_000 });
    await openSettingsSection(page, "desktop");
    assert.equal(await page.locator('.theme-swatch[data-theme="graphite"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("html").getAttribute("data-desktop-theme"), "graphite");
    assert.equal(await page.locator(".directions-toggle").getAttribute("aria-pressed"), directionsAfterChange);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron keeps a stopped summary visible until the writer discards it", async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-summary-stop-e2e-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_STATE: path.join(directory, "machine"),
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Stopped summary");
    await page.locator(".composer-input").fill("A saved line gives the summary enough source text.");
    await page.locator(".composer-manual").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });

    await openPartMenuAndClick(page, 0, ".summary-take");
    await page.waitForSelector(".stream-card", { timeout: 15_000 });
    await page.waitForFunction(
      () => (document.querySelector(".stream-text")?.textContent?.length ?? 0) > 8,
      undefined,
      { timeout: 15_000 }
    );
    await page.locator(".stream-stop").click();
    await page.waitForSelector(".stopped-generation", { timeout: 30_000 });
    assert.equal(await page.locator(".stopped-save").count(), 0);
    assert.equal(await page.locator(".stopped-discard").count(), 1);
    assert.match(await page.locator(".stopped-generation").innerText(), /not saved as story prose/u);
    assert.match(await page.locator(".toast").innerText(), /Stopped summary kept for review/u);
    const stoppedText = await page.locator(".stopped-generation-text").innerText();
    assert.ok(stoppedText.length > 8, "stopped summary must remain visible");

    await page.locator(".stopped-discard").click();
    await page.waitForSelector(".stopped-generation", { state: "detached", timeout: 15_000 });
    assert.match(await page.locator(".toast").innerText(), /Interrupted summary discarded/u);
    assert.equal(await page.locator(".manuscript-part").count(), 1);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron keeps a new direction typed during successful generation", { timeout: 120_000 }, async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-generation-draft-e2e-"));
  const dataDir = path.join(directory, ".1667");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_STATE: path.join(directory, "machine"),
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Generation draft");
    await page.locator(".composer-input").fill("Write the first passage.");
    await page.locator(".composer-submit").click();
    await page.waitForFunction(
      () => document.querySelector(".stream-card") !== null
        && (document.querySelector(".stream-text")?.textContent?.length ?? 0) > 8,
      undefined,
      { timeout: 30_000 }
    );
    await page.locator(".composer-input").fill("Write the next passage after this one.");
    await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    assert.equal(await page.locator(".composer-input").inputValue(), "Write the next passage after this one.");

    await goToLibrary(page);
    await page.locator(".project-browser").click();
    await page.waitForSelector(".launcher-page", { timeout: 15_000 });
    await page.locator(".recent-project").first().click();
    const discardDialog = page.locator('.modal-card[aria-label="Discard unsaved edits?"]');
    await discardDialog.waitFor({ state: "visible", timeout: 15_000 });
    assert.match(await discardDialog.innerText(), /direction/u);
    await discardDialog.locator(".modal-cancel").click();
    await page.waitForSelector(".modal-card", { state: "detached", timeout: 15_000 });
    await page.getByRole("button", { name: "Back to story" }).click();
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    assert.equal(await page.locator(".composer-input").inputValue(), "Write the next passage after this one.");
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron keeps drafts and navigation while story creation completes", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-delayed-create-e2e-"));
  const dataDir = path.join(directory, ".1667");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_STATE: path.join(directory, "machine"),
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Creation origin");

    await delayCreateStory(page, 1_500);
    await goToLibrary(page);
    await page.locator(".new-story-button").click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.locator(".modal-input").fill("Delayed created story");
    await page.locator(".modal-submit").click();
    await page.waitForFunction(
      () => (window as Window & { __delayedCreateStory?: boolean }).__delayedCreateStory === true,
      undefined,
      { timeout: 15_000 }
    );
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    await page.locator(".composer-input").fill("Draft while story creation is pending.");
    await page.waitForFunction(
      () => document.querySelector(".story-title")?.textContent === "Creation origin",
      undefined,
      { timeout: 15_000 }
    );
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Story created; current story kept") === true,
      undefined,
      { timeout: 30_000 }
    );
    assert.match(await page.locator(".toast").innerText(), /Story created; current story kept/u);
    assert.equal(await page.locator(".composer-input").inputValue(), "Draft while story creation is pending.");
    await goToLibrary(page);
    await page.waitForFunction(
      () => [...document.querySelectorAll(".story-row")]
        .some((row) => row.textContent?.includes("Delayed created story") === true),
      undefined,
      { timeout: 30_000 }
    );
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });

    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    assert.equal(await page.locator(".story-title").innerText(), "Creation origin");
    assert.equal(await page.locator(".composer-input").inputValue(), "Draft while story creation is pending.");

    await page.locator(".composer-input").fill("");
    await createStory(page, "Creation destination");
    await selectStory(page, "Creation origin");
    await delayCreateStory(page, 1_500);
    await delayStoryLoad(page, 2_500);
    await goToLibrary(page);
    await page.locator(".new-story-button").click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.locator(".modal-input").fill("Delayed navigation story");
    await page.locator(".modal-submit").click();
    await page.waitForFunction(
      () => (window as Window & { __delayedCreateStory?: boolean }).__delayedCreateStory === true,
      undefined,
      { timeout: 15_000 }
    );
    await page.locator(".story-row").filter({ hasText: "Creation destination" }).click();
    await page.waitForFunction(
      () => [...document.querySelectorAll(".story-row")]
        .some((row) => row.textContent?.includes("Delayed navigation story") === true),
      undefined,
      { timeout: 30_000 }
    );
    assert.equal(await page.locator(".story-title").innerText(), "Creation origin");
    await page.waitForFunction(
      () => document.querySelector(".story-title")?.textContent === "Creation destination",
      undefined,
      { timeout: 30_000 }
    );
    assert.equal(await page.locator(".story-title").innerText(), "Creation destination");
    assert.match(await page.locator(".toast").innerText(), /Story loaded/u);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron keeps newer part text after a delayed save and rerender", { timeout: 120_000 }, async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-delayed-save-e2e-"));
  const dataDir = path.join(directory, ".1667");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_STATE: path.join(directory, "machine"),
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Delayed part save");
    await page.locator(".composer-input").fill("A saved base line.");
    await page.locator(".composer-manual").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });

    const submitted = "The submitted edit arrives first.";
    const newer = "The newer edit must remain after the save.";
    const editing = await editPart(page, "last");
    await editing.fill(submitted);
    await delayEditNode(page);
    await page.locator(".part-save").last().click();
    await page.waitForFunction(
      () => (window as Window & { __delayedEditNode?: boolean }).__delayedEditNode === true,
      undefined,
      { timeout: 15_000 }
    );
    await page.locator(".part-text").last().fill(newer);
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Saved") === true,
      undefined,
      { timeout: 30_000 }
    );
    // The save's own text (`submitted`) no longer matches the draft the
    // writer kept typing (`newer`), so the draft survives — but a completed
    // save still leaves edit mode (D-09), so the part shows it as prose now.
    await page.waitForSelector(".part-text", { state: "detached", timeout: 15_000 });
    assert.equal(await page.locator(".manuscript-part").last().locator(".part-prose").innerText(), newer);

    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    assert.equal(await page.locator(".manuscript-part").last().locator(".part-prose").innerText(), newer);

    await goToLibrary(page);
    await page.locator(".project-browser").click();
    await page.waitForSelector(".launcher-page", { timeout: 15_000 });
    await page.waitForSelector(".recent-project", { timeout: 15_000 });
    await page.locator(".recent-project").first().click();
    const discardDialog = page.locator('.modal-card[aria-label="Discard unsaved edits?"]');
    await discardDialog.waitFor({ state: "visible", timeout: 15_000 });
    assert.match(await discardDialog.innerText(), /part text/u);
    await discardDialog.locator(".modal-cancel").click();
    await page.getByRole("button", { name: "Back to story" }).click();
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    assert.equal(await page.locator(".manuscript-part").last().locator(".part-prose").innerText(), newer);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron ignores a delayed part save after the writer changes stories", { timeout: 120_000 }, async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-delayed-story-save-e2e-"));
  const dataDir = path.join(directory, ".1667");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_STATE: path.join(directory, "machine"),
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Delayed source story");
    await page.locator(".composer-input").fill("A saved source line.");
    await page.locator(".composer-manual").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });
    await createStory(page, "Other story");
    await selectStory(page, "Delayed source story");

    const sourcePart = await editPart(page, "last");
    await sourcePart.fill("A source edit still in flight.");
    await delayEditNode(page, 2_000);
    await page.locator(".part-save").last().click();
    await page.waitForFunction(
      () => (window as Window & { __delayedEditNode?: boolean }).__delayedEditNode === true,
      undefined,
      { timeout: 15_000 }
    );

    await goToLibrary(page);
    await page.locator(".story-row").filter({ hasText: "Other story" }).click();
    const discardDialog = page.locator('.modal-card[aria-label="Discard unsaved edits?"]');
    await discardDialog.waitFor({ state: "visible", timeout: 15_000 });
    await discardDialog.locator(".modal-submit").click();
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "Other story", undefined, { timeout: 30_000 });
    await page.locator(".composer-input").fill("Draft in the other story.");
    await page.waitForTimeout(2_500);
    await page.locator(".tab-settings").click();
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    assert.equal(await page.locator(".story-title").innerText(), "Other story");
    assert.equal(await page.locator(".composer-input").inputValue(), "Draft in the other story.");
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

async function selectStory(page: Page, title: string): Promise<void> {
  await goToLibrary(page);
  await page.locator(".story-row").filter({ hasText: title }).click();
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 15_000 });
}

/** "Write from here", "Summary take", and the other per-part verbs that used
 * to sit in the always-visible tools row now live in the part's `···`
 * overflow menu (D-11): hover the part to reveal its toolbar, open the menu,
 * then click the verb inside it. The menu closes itself once the verb runs. */
async function openPartMenuAndClick(page: Page, nth: number, selector: string): Promise<void> {
  const part = page.locator(".manuscript-part").nth(nth);
  await part.locator(".part-prose").hover();
  await part.locator(".part-more").click();
  await page.waitForSelector(".part-menu", { timeout: 15_000 });
  await page.locator(`.part-menu ${selector}`).click();
}

async function delayEditNode(page: Page, delayMs = 750): Promise<void> {
  await page.evaluate((delay) => {
    const runtime = window as Window & { __delayedEditNode?: boolean };
    const postMessage = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message: unknown): void {
      const request = message as { readonly type?: unknown; readonly method?: unknown };
      if (request.type === "request" && request.method === "editNode") {
        runtime.__delayedEditNode = true;
        window.setTimeout(() => postMessage.call(this, message), delay);
        return;
      }
      postMessage.call(this, message);
    };
  }, delayMs);
}

async function delayCreateStory(page: Page, delayMs = 750): Promise<void> {
  await page.evaluate((delay) => {
    const runtime = window as Window & { __delayedCreateStory?: boolean };
    runtime.__delayedCreateStory = false;
    const postMessage = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message: unknown): void {
      const request = message as { readonly type?: unknown; readonly method?: unknown };
      if (request.type === "request" && request.method === "createStory" && runtime.__delayedCreateStory !== true) {
        runtime.__delayedCreateStory = true;
        window.setTimeout(() => postMessage.call(this, message), delay);
        return;
      }
      postMessage.call(this, message);
    };
  }, delayMs);
}

async function delayStoryLoad(page: Page, delayMs = 750): Promise<void> {
  await page.evaluate((delay) => {
    const runtime = window as Window & { __delayNextStoryLoad?: boolean };
    runtime.__delayNextStoryLoad = true;
    const postMessage = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message: unknown): void {
      const request = message as { readonly type?: unknown; readonly method?: unknown };
      if (runtime.__delayNextStoryLoad === true && request.type === "request" && request.method === "loadStory") {
        runtime.__delayNextStoryLoad = false;
        window.setTimeout(() => postMessage.call(this, message), delay);
        return;
      }
      postMessage.call(this, message);
    };
  }, delayMs);
}

test("Electron retains drafts after a refused project open and guards hidden part edits", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-draft-navigation-"));
  const dataDir = path.join(directory, "story-project", ".1667");
  const plainDir = path.join(directory, "plain-folder");
  await mkdir(dataDir, { mode: 0o700, recursive: true });
  await mkdir(plainDir);
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    env: { ...process.env, AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_STATE: path.join(directory, "machine"), AI_1667_NO_UPDATE_CHECK: "1" }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Draft navigation");
    for (const text of ["First saved part.", "Second saved part."]) {
      const count = await page.locator(".manuscript-part").count();
      await page.locator(".composer-input").fill(text);
      await page.locator(".composer-manual").click();
      await page.waitForFunction((expected) => document.querySelectorAll(".manuscript-part").length === expected,
        count + 1, { timeout: 15_000 });
    }
    const secondPart = await editPart(page, "last");
    await secondPart.fill("Unsaved second part.");
    await page.locator(".composer-input").fill("Keep my next direction.");
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, plainDir);
    await goToLibrary(page);
    await page.locator(".project-browser").click();
    await page.getByRole("button", { name: "Open project folder" }).click();
    await page.waitForSelector('.modal-card[aria-label="Discard unsaved edits?"]', { timeout: 15_000 });
    await page.locator(".modal-submit").click();
    await page.waitForFunction(() => document.querySelector(".launcher-error")?.textContent?.includes("Choose Create project") === true,
      undefined, { timeout: 30_000 });
    await page.getByRole("button", { name: "Back to story" }).click();
    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
    // Still mid-edit on the second part: nothing since touched editingPartId.
    assert.equal(await page.locator(".part-text").last().inputValue(), "Unsaved second part.");
    assert.equal(await page.locator(".composer-input").inputValue(), "Keep my next direction.");
    await openPartMenuAndClick(page, 0, ".part-switch");
    await page.waitForSelector('.modal-card[aria-label="Discard part edits?"]', { timeout: 15_000 });
    await page.locator(".modal-cancel").click();
    // Cancelling the discard must leave both parts, with the hidden second
    // part's unsaved edit intact (it is still the one part-text in edit
    // mode — only one part ever edits at a time now).
    assert.equal(await page.locator(".manuscript-part").count(), 2);
    assert.equal(await page.locator(".part-text").last().inputValue(), "Unsaved second part.");
    await openPartMenuAndClick(page, 0, ".part-switch");
    await page.locator(".modal-submit").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });
    assert.equal(await page.locator(".composer-input").inputValue(), "Keep my next direction.");
    await page.locator(".composer-input").fill("");
    await page.locator(".tab-settings").click();
    await page.locator(".tab-write").click();
    assert.doesNotMatch(await page.locator(".toast").innerText(), /unsaved edits/u);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});
