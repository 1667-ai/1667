import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { createWorkerHost } from "../../host/worker-host.js";
import { initializeProject } from "../../host/launcher-project.js";
import { storyApiFromWorkerTransport } from "../../client/worker-story-api.js";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import { closeDesktopApp, editPart, goToLibrary } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

test("Electron reloads the latest story while retaining a second window draft", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-renderer-conflict-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await launch(directory, dataDir);
  try {
    const first = await app.firstWindow();
    await first.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(first, "Shared draft");
    await first.locator(".composer-input").fill("A saved base line.");
    await first.locator(".composer-manual").click();
    await first.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });

    const second = await openSecondWindow(app, first);
    const draft = await editPart(second, "last");
    await draft.fill("Unsaved text from the second window.");

    await goToLibrary(first);
    await first.locator(".rename-story").click();
    await first.waitForSelector(".modal-card", { timeout: 15_000 });
    await first.locator(".modal-input").fill("Renamed by the first window");
    await first.locator(".modal-submit").click();
    await first.waitForFunction(
      () => document.querySelector(".story-title")?.textContent === "Renamed by the first window",
      undefined,
      { timeout: 15_000 }
    );

    await second.locator(".part-save").last().click();
    await second.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("retry the action") === true,
      undefined,
      { timeout: 15_000 }
    );
    assert.equal(await second.locator(".story-title").innerText(), "Renamed by the first window");
    // A failed save leaves the part in edit mode with its draft intact.
    assert.equal(await second.locator(".part-text").last().inputValue(), "Unsaved text from the second window.");

    await second.locator(".part-save").last().click();
    await second.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Saved") === true,
      undefined,
      { timeout: 15_000 }
    );
    // A successful save leaves edit mode; the saved text now shows in the prose.
    await second.waitForSelector(".part-text", { state: "detached", timeout: 15_000 });
    assert.equal(await second.locator(".part-prose").last().innerText(), "Unsaved text from the second window.");
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron resets the settings editor when the project changes", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-renderer-settings-switch-"));
  const dataDir = path.join(directory, "project");
  const destinationRoot = path.join(directory, "destination");
  await mkdir(dataDir, { mode: 0o700 });
  const destination = await initializeProject(destinationRoot);
  try {
    const seededHost = await createWorkerHost({
      dataDir: destination.directory,
      machineDir: path.join(directory, "seed-machine")
    });
    try {
      const seededApi = storyApiFromWorkerTransport(seededHost.transport);
      const initial = await seededApi.getSettings();
      assert.ok(initial.editable);
      await seededApi.saveSettings({
        transportOperationId: crypto.randomUUID(),
        mutationId: createDurableMutationId(),
        expectedStateGeneration: initial.stateGeneration,
        document: applyBasicSettingsDraft(initial.document, { ...initial.effective, maxTokens: 321 })
      });
    } finally {
      await seededHost.dispose();
    }

    const app = await launch(directory, dataDir);
    try {
      const page = await app.firstWindow();
      await page.waitForSelector(".new-story-button", { timeout: 30_000 });
      await page.locator(".tab-settings").click();
      await page.waitForSelector(".settings-editor", { timeout: 15_000 });
      const maxTokens = page.locator('[data-settings-field="profile.maxOutputTokens"]');
      await maxTokens.fill("654");
      await page.locator(".settings-save").click();
      await page.waitForFunction(
        () => document.querySelector(".toast")?.textContent?.includes("Settings saved") === true,
        undefined,
        { timeout: 15_000 }
      );

      const response = await page.evaluate(async (root) => {
        const desktop = (window as unknown as {
          desktop?: { shell?: { request(request: unknown): Promise<{ readonly ok: boolean }> } }
        }).desktop;
        return await desktop?.shell?.request({ type: "project.open", root });
      }, destinationRoot);
      assert.equal(response?.ok, true);
      await page.waitForSelector(".settings-editor", { timeout: 30_000 });
      await page.waitForFunction(
        () => (document.querySelector('[data-settings-field="profile.maxOutputTokens"]') as HTMLInputElement | null)?.value === "321",
        undefined,
        { timeout: 30_000 }
      );
      assert.equal(await page.locator('[data-settings-field="profile.maxOutputTokens"]').inputValue(), "321");
    } finally {
      await closeDesktopApp(app);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron retains stopped text when a concurrent rename advances the story", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-stopped-conflict-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await launch(directory, dataDir);
  try {
    const first = await app.firstWindow();
    await first.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(first, "Stopped generation");
    await first.locator(".composer-input").fill("A saved parent line.");
    await first.locator(".composer-manual").click();
    await first.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });

    const second = await openSecondWindow(app, first);
    await first.locator(".composer-mode-direct").click();
    await first.locator(".composer-input").fill("Continue the scene while the other window renames it.");
    await first.locator(".composer-submit").click();
    await first.waitForSelector(".stream-card", { timeout: 15_000 });
    await first.waitForFunction(
      () => (document.querySelector(".stream-text")?.textContent?.length ?? 0) > 8,
      undefined,
      { timeout: 15_000 }
    );
    await first.waitForTimeout(300);

    await goToLibrary(second);
    await second.locator(".rename-story").click();
    await second.waitForSelector(".modal-card", { timeout: 15_000 });
    await second.locator(".modal-input").fill("Renamed during stopped generation");
    await second.locator(".modal-submit").click();
    await first.locator(".stream-stop").click();
    await second.waitForFunction(
      () => document.querySelector(".story-title")?.textContent === "Renamed during stopped generation",
      undefined,
      { timeout: 15_000 }
    );

    await first.waitForSelector(".stopped-generation", { timeout: 30_000 });
    assert.equal(await first.locator(".story-title").innerText(), "Renamed during stopped generation");
    const stoppedText = await first.locator(".stopped-generation-text").innerText();
    assert.ok(stoppedText.length > 8, "stopped text must remain visible after the conflict");
    assert.match(await first.locator(".error-banner").innerText(), /story changed/u);
    assert.match(await first.locator(".toast").innerText(), /retry interrupted text save/u);

    await first.locator(".stopped-save").click();
    await first.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Interrupted text saved") === true,
      undefined,
      { timeout: 30_000 }
    );
    assert.equal(await first.locator(".stopped-generation").count(), 0);
    assert.equal(await first.locator(".manuscript-part").count(), 2);
    assert.ok((await first.locator(".part-prose").last().innerText()).length > 8);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron creates a child for a typed Continue direction", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-continue-child-e2e-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await launch(directory, dataDir);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Typed continuation");
    await page.locator(".composer-input").fill("A saved parent line.");
    await page.locator(".composer-manual").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });
    const parentText = await page.locator(".part-prose").last().innerText();
    const direction = "The visitor opens the old gate.";
    await page.locator(".composer-mode-continue").click();
    await page.locator(".composer-input").fill(direction);
    await page.locator(".composer-submit").click();
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 2, undefined, { timeout: 30_000 });
    assert.equal(await page.locator(".part-prose").first().innerText(), parentText);
    assert.equal(await page.locator(".part-instruction").last().innerText(), direction);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron creates a child below a saved summary for empty Continue", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-summary-continue-e2e-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await launch(directory, dataDir);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Summary continuation");
    await page.locator(".composer-input").fill("A saved parent line.");
    await page.locator(".composer-manual").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });
    // Summary take (§4/§8) now lives in a part's `···` overflow menu.
    const onlyPart = page.locator(".manuscript-part").last();
    await onlyPart.locator(".part-prose").hover();
    await onlyPart.locator(".part-more").click();
    await page.waitForSelector(".part-menu", { timeout: 15_000 });
    await page.locator(".part-menu .summary-take").click();
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
    const summaryCount = await page.locator(".manuscript-part").count();
    assert.equal(summaryCount, 2);
    assert.equal(await page.locator(".manuscript-part").last().evaluate((el) => el.classList.contains("summary")), true);
    assert.match(await page.locator(".part-summary-header").last().innerText(), /summary/iu);

    await page.locator(".composer-mode-continue").click();
    await page.locator(".composer-input").fill("");
    await page.locator(".composer-submit").click();
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
    await page.waitForFunction((expected) => document.querySelectorAll(".manuscript-part").length === expected,
      summaryCount + 1, { timeout: 30_000 });
    assert.ok((await page.locator(".part-instruction").last().innerText()).length > 0);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron clears the keyboard-submitted direction after a successful take", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-keyboard-submit-e2e-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await launch(directory, dataDir);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Keyboard submit");
    await page.locator(".composer-input").fill("A saved parent line.");
    await page.locator(".composer-manual").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });
    await page.locator(".composer-mode-direct").click();
    const direction = "The visitor opens the old gate.";
    const composer = page.locator(".composer-input");
    await composer.fill(direction);
    await composer.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Enter`);
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
    await page.waitForFunction(() => (document.querySelector(".composer-input") as HTMLTextAreaElement | null)?.value === "", undefined, { timeout: 15_000 });
    assert.equal(await composer.inputValue(), "");
    assert.equal((await page.locator(".story-save-state").innerText()).toLocaleLowerCase(), "saved");
    await page.locator(".request-details summary").click();
    await page.waitForFunction(
      (expected) => [...document.querySelectorAll(".request-message-text")]
        .map((element) => element.textContent ?? "")
        .join("\n")
        .split(expected).length - 1 === 1,
      direction,
      { timeout: 15_000 }
    );
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron retake creates a continuation sibling and keeps the original take", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-retake-e2e-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await launch(directory, dataDir);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Retake story");
    await page.locator(".composer-input").fill("A saved parent line.");
    await page.locator(".composer-manual").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });

    const direction = "The visitor opens the old gate.";
    await page.locator(".composer-mode-direct").click();
    await page.locator(".composer-input").fill(direction);
    await page.locator(".composer-submit").click();
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
    const original = page.locator(".manuscript-part").last();
    const originalText = await original.locator(".part-prose").innerText();
    const originalInstruction = await original.locator(".part-instruction").innerText();

    // `.part-retake` (D-11) is the `r`-key verb: it reuses the part's saved
    // direction and retakes immediately, with no dialog.
    await original.locator(".part-prose").hover();
    await original.locator(".part-retake").click();
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
    assert.equal(await page.locator(".part-instruction").last().innerText(), originalInstruction);

    await page.locator(".tab-inspect").click();
    await page.waitForSelector(".inspect-records", { timeout: 15_000 });
    await page.locator(".inspect-records").last().click();
    await page.locator(".inspector-result:not(.busy) pre").waitFor({ state: "visible", timeout: 15_000 });
    assert.match(await page.locator(".inspector-result pre").innerText(), /"kind": "continue"/u);

    await page.locator(".tab-write").click();
    await page.locator(".part-take-previous").last().click();
    await page.waitForFunction((expected) => document.querySelector(".manuscript-part.focused .part-prose")?.textContent === expected, originalText, { timeout: 15_000 });
    assert.equal(await page.locator(".part-prose").last().innerText(), originalText);
    assert.equal(await page.locator(".part-instruction").last().innerText(), originalInstruction);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron saves an edited take and edits its direction", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-edited-take-e2e-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await launch(directory, dataDir);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Edited take story");
    await page.locator(".composer-input").fill("A saved parent line.");
    await page.locator(".composer-manual").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });

    const direction = "The visitor opens the old gate.";
    await page.locator(".composer-mode-direct").click();
    await page.locator(".composer-input").fill(direction);
    await page.locator(".composer-submit").click();
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
    const original = page.locator(".manuscript-part").last();
    const originalText = await original.locator(".part-prose").innerText();
    const originalInstruction = await original.locator(".part-instruction").innerText();
    const editedText = `${originalText} The brass key turns twice.`;
    await original.locator(".part-prose").dblclick();
    const editor = original.locator(".part-text");
    await editor.waitFor({ state: "visible", timeout: 15_000 });
    await editor.fill(editedText);
    await original.locator(".part-save-take").click();
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Saved as take") === true,
      undefined,
      { timeout: 30_000 }
    );
    // Saving as a take also leaves edit mode; the saved text now shows as prose.
    await page.waitForSelector(".part-text", { state: "detached", timeout: 15_000 });
    assert.equal(await page.locator(".part-prose").last().innerText(), editedText);

    await page.locator(".manuscript-part").last().locator(".part-prose").dblclick();
    await page.locator(".part-text").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(".part-edit-direction").last().click();
    const directionDialog = page.locator('.modal-card[aria-label="Edit direction"]');
    await directionDialog.waitFor({ state: "visible", timeout: 15_000 });
    await directionDialog.locator(".modal-input").fill("The visitor uses the brass key.");
    await directionDialog.locator(".modal-submit").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".part-instruction").item(document.querySelectorAll(".part-instruction").length - 1)?.textContent === "The visitor uses the brass key.",
      undefined,
      { timeout: 15_000 }
    );
    await page.keyboard.press("Escape");
    await page.waitForSelector(".part-text", { state: "detached", timeout: 15_000 });

    await page.locator(".part-take-previous").last().click();
    await page.waitForFunction((expected) => document.querySelector(".manuscript-part.focused .part-prose")?.textContent === expected, originalText, { timeout: 15_000 });
    assert.equal(await page.locator(".part-prose").last().innerText(), originalText);
    assert.equal(await page.locator(".part-instruction").last().innerText(), originalInstruction);
    await page.locator(".part-take-next").last().click();
    await page.waitForFunction((expected) => document.querySelector(".manuscript-part.focused .part-prose")?.textContent === expected, editedText, { timeout: 15_000 });
    assert.equal(await page.locator(".part-prose").last().innerText(), editedText);
    assert.equal(await page.locator(".part-instruction").last().innerText(), "The visitor uses the brass key.");
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron drops drafts for a take removed by prune", { timeout: 120_000 }, async () => {
  assert.ok(appPath, "AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry");
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-prune-draft-e2e-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await launch(directory, dataDir);
  try {
    const first = await app.firstWindow();
    await first.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(first, "Prune drafts");
    await createStory(first, "Other story");
    await selectStory(first, "Prune drafts");
    await first.locator(".composer-input").fill("A saved parent line.");
    await first.locator(".composer-manual").click();
    await first.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, undefined, { timeout: 15_000 });

    await first.locator(".composer-mode-direct").click();
    await first.locator(".composer-input").fill("The first take opens the gate.");
    await first.locator(".composer-submit").click();
    await first.waitForSelector(".stream-card", { timeout: 30_000 });
    await first.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
    // A stream renders as its own `.manuscript-part.streaming`, appended
    // after the real parts, so `.manuscript-part` alone stops meaning "the
    // last real part" once one starts — pin the original part's own
    // `data-preserve` key first and address it by that from here on.
    const originalKey = await first.locator(".manuscript-part").last().getAttribute("data-preserve");
    assert.ok(originalKey, "the original part must have a stable draft key");
    const original = first.locator(`[data-preserve="${originalKey}"]`);
    await original.locator(".part-prose").hover();
    // `.part-retake` (D-11) reuses the saved direction and retakes at once,
    // with no dialog — the original part is still on the path while it
    // streams, so it can still be opened and edited underneath the stream.
    await original.locator(".part-retake").click();
    await first.waitForSelector(".stream-card", { timeout: 15_000 });
    await original.locator(".part-prose").dblclick();
    await original.locator(".part-text").waitFor({ state: "visible", timeout: 15_000 });
    // Keep an edit on the original take while Retake is in flight. The new
    // sibling makes that draft hidden, then prune must remove the old branch.
    await original.locator(".part-text").fill("Draft on the take that will be pruned.");
    await first.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });

    assert.equal((await first.locator(".story-save-state").innerText()).toLocaleLowerCase(), "unsaved edits");

    const currentPart = first.locator(".manuscript-part").last();
    await currentPart.locator(".part-prose").hover();
    await currentPart.locator(".part-more").click();
    await first.waitForSelector(".part-menu", { timeout: 15_000 });
    await first.locator(".part-menu .prune-unused").click();
    const firstDialog = first.locator('.modal-card[aria-label="Prune unused takes"]');
    await firstDialog.waitFor({ state: "visible", timeout: 15_000 });
    await firstDialog.locator(".modal-submit").click();
    await first.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Pruned 1 unused take") === true,
      undefined,
      { timeout: 30_000 }
    );
    assert.equal((await first.locator(".story-save-state").innerText()).toLocaleLowerCase(), "saved");

    await goToLibrary(first);
    await first.locator(".story-row").filter({ hasText: "Other story" }).click();
    await first.waitForFunction(
      () => document.querySelector(".story-title")?.textContent === "Other story",
      undefined,
      { timeout: 15_000 }
    );
    assert.equal(await first.locator('.modal-card[aria-label="Discard unsaved edits?"]').count(), 0);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

async function launch(directory: string, dataDir: string): Promise<ElectronApplication> {
  return await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath!],
    env: {
      ...process.env,
      AI_1667_STATE: path.join(directory, "machine"),
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
}

async function openSecondWindow(app: ElectronApplication, first: Page): Promise<Page> {
  const opened = app.waitForEvent("window");
  await first.bringToFront();
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
    const item = file?.submenu?.items.find((entry) => entry.label === "New Window");
    if (item?.click === undefined) throw new Error("File > New Window is unavailable");
    item.click(item, null, null);
  });
  const second = await opened;
  await second.waitForSelector(".story-title", { timeout: 30_000 });
  await second.locator(".tab-write").click();
  await second.waitForSelector(".composer-input", { timeout: 15_000 });
  return second;
}

async function createStory(page: Page, title: string): Promise<void> {
  await goToLibrary(page);
  await page.locator(".new-story-button").click();
  await page.waitForSelector(".modal-card", { timeout: 15_000 });
  await page.locator(".modal-input").fill(title);
  await page.locator(".modal-submit").click();
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 30_000 });
}

async function selectStory(page: Page, title: string): Promise<void> {
  await goToLibrary(page);
  await page.locator(".story-row").filter({ hasText: title }).click();
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 30_000 });
}
