import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type Page } from "playwright";
import { closeDesktopApp, goToLibrary } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

test("Electron settings toggles thoughts, persists profiles, and discards pending candidates", async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-settings-e2e-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-settings-state-e2e-"));
  const exportDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-settings-export-e2e-"));
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(stateDir, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_STATE: stateDir,
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await page.click(".new-story-button");
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.fill(".modal-input", "Settings proof");
    await page.click(".modal-submit");
    await page.waitForSelector(".story-title", { timeout: 30_000 });
    await page.click(".tab-settings");
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });

    const keepThoughts = page.locator(".settings-control-profile-discardReasoning");
    assert.equal(await keepThoughts.isChecked(), true);
    await keepThoughts.uncheck();
    await page.click(".settings-save");
    await page.waitForFunction(
      () => (document.querySelector(".settings-save") as HTMLButtonElement | null)?.disabled === false
        && document.querySelector(".toast")?.textContent?.includes("Settings saved") === true
        || Boolean(document.querySelector(".settings-global-error")?.textContent),
      undefined,
      { timeout: 30_000 }
    );
    assert.deepEqual(await page.locator(".settings-global-error").allTextContents(), []);
    await page.reload();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await page.click(".tab-settings");
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    assert.equal(await page.locator(".settings-control-profile-discardReasoning").isChecked(), false);

    await page.locator(".settings-control-profile-discardReasoning").check();
    await page.click(".settings-save");
    await page.waitForFunction(
      () => (document.querySelector(".settings-save") as HTMLButtonElement | null)?.disabled === false
        && document.querySelector(".toast")?.textContent?.includes("Settings saved") === true
        || Boolean(document.querySelector(".settings-global-error")?.textContent),
      undefined,
      { timeout: 30_000 }
    );
    assert.deepEqual(await page.locator(".settings-global-error").allTextContents(), []);
    await page.reload();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await page.click(".tab-settings");
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    assert.equal(await page.locator(".settings-control-profile-discardReasoning").isChecked(), true);

    await page.click(".settings-connection-create");
    const profileName = await page.locator(".settings-profile-select.active strong").innerText();
    await page.fill(".settings-control-connection-name", "Saved provider");
    await page.selectOption(".settings-control-connection-preset", "custom");
    await page.selectOption(".settings-control-connection-protocol", "openai-chat-completions");
    await page.fill(".settings-control-connection-baseUrl", "https://example.test/v1");
    await page.selectOption(".settings-control-connection-authType", "bearer-stored");
    const secret = page.locator("input[data-preserve^='settings:secret:']");
    await secret.fill("pending-secret");
    await page.click(".settings-profile-duplicate");
    const selectedProfileName = await page.locator(".settings-profile-select.active strong").innerText();
    assert.notEqual(selectedProfileName, profileName);
    assert.equal(await page.locator("input[data-preserve^='settings:secret:']").inputValue(), "pending-secret");
    await page.locator(".settings-profile-select").filter({
      has: page.locator("strong").filter({ hasText: new RegExp(`^${escapeRegExp(profileName)}$`, "u") })
    }).click();

    await typeSetting(page, ".settings-control-sampling-topP", "0.7");
    await typeSetting(page, ".settings-control-profile-temperature", "0.9");
    await page.fill(".settings-control-sampling-topK", "200");
    await page.fill(".settings-control-sampling-seed", "12345");
    await page.fill(".settings-control-sampling-dryRange", "131072");
    assert.equal(await page.locator(".settings-control-sampling-topK").inputValue(), "200");
    assert.equal(await page.locator(".settings-control-sampling-seed").inputValue(), "12345");
    assert.equal(await page.locator(".settings-control-sampling-dryRange").inputValue(), "131072");
    await page.fill(".settings-control-sampling-topK", "");
    await page.fill(".settings-control-sampling-seed", "");
    await page.fill(".settings-control-sampling-dryRange", "");
    await page.fill(".settings-control-sampling-stop", "END\nTHE END");
    await page.fill(".settings-control-profile-tokenProbabilities", "4");
    await page.fill(".settings-control-profile-tokenProbabilities", "");
    await page.selectOption(".settings-control-route-prose", { label: profileName });
    await page.click(".settings-save");
    await page.waitForFunction(
      () => (document.querySelector(".settings-save") as HTMLButtonElement | null)?.disabled === false
        && document.querySelector(".toast")?.textContent?.includes("Settings saved") === true
        || Boolean(document.querySelector(".settings-global-error")?.textContent),
      undefined,
      { timeout: 30_000 }
    );
    assert.deepEqual(await page.locator(".settings-global-error").allTextContents(), []);
    assert.equal(await page.locator(".settings-profile-select.active strong").innerText(), profileName);
    assert.equal(await page.locator(".settings-control-sampling-topP").inputValue(), "0.7");
    assert.equal(await page.locator(".settings-control-profile-temperature").inputValue(), "0.9");

    await page.locator(".settings-profile-select").filter({
      has: page.locator("strong").filter({ hasText: new RegExp(`^${escapeRegExp(selectedProfileName)}$`, "u") })
    }).click();
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, exportDir);
    await page.click(".profile-export");
    const exportedFile = await waitForExport(exportDir);
    const exported = JSON.parse(await readFile(path.join(exportDir, exportedFile), "utf8")) as { readonly name?: unknown };
    assert.equal(exported.name, selectedProfileName);
    const exportedPath = path.join(exportDir, exportedFile);
    const invalidProfilePath = path.join(exportDir, "invalid.profile.json");
    await writeFile(invalidProfilePath, "{}\n", "utf8");

    const profileCountBeforeImport = await page.locator(".settings-profile-card").count();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, exportedPath);
    await page.click(".profile-import");
    await page.waitForFunction(
      (expected) => document.querySelectorAll(".settings-profile-card").length > expected,
      profileCountBeforeImport,
      { timeout: 30_000 }
    );
    const importedCount = await page.locator(".settings-profile-card").count();
    assert.equal(importedCount, profileCountBeforeImport + 1);
    await page.locator(".settings-profile-select").last().click();
    await page.fill(".settings-control-profile-maxOutputTokens", "2049");
    await page.click(".settings-save");
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Settings saved") === true
        || Boolean(document.querySelector(".settings-global-error")?.textContent),
      undefined,
      { timeout: 30_000 }
    );
    assert.deepEqual(await page.locator(".settings-global-error").allTextContents(), []);

    await page.click(".tab-write");
    await page.fill(".composer-input", "Keep this composer draft during profile import.");
    await page.click(".tab-settings");
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await page.fill(".settings-control-sampling-topP", "0.91");
    const profileCountBeforeConfirmedImport = await page.locator(".settings-profile-card").count();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, invalidProfilePath);
    await page.click(".profile-import");
    await page.locator('.modal-card[aria-label="Discard Settings edits?"] .modal-submit').click();
    await page.waitForSelector(".error-banner", { timeout: 15_000 });
    assert.equal(await page.locator(".settings-control-sampling-topP").inputValue(), "0.91");

    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, exportedPath);
    await page.click(".profile-import");
    const discardSettingsDialog = page.locator('.modal-card[aria-label="Discard Settings edits?"]');
    await discardSettingsDialog.waitFor({ state: "visible", timeout: 15_000 });
    await discardSettingsDialog.locator(".modal-cancel").click();
    await page.waitForSelector('.modal-card[aria-label="Discard Settings edits?"]', { state: "detached", timeout: 15_000 });
    assert.equal(await page.locator(".settings-control-sampling-topP").inputValue(), "0.91");

    await page.click(".profile-import");
    await page.locator('.modal-card[aria-label="Discard Settings edits?"] .modal-submit').click();
    await page.waitForFunction(
      (expected) => document.querySelectorAll(".settings-profile-card").length > expected,
      profileCountBeforeConfirmedImport,
      { timeout: 30_000 }
    );
    await page.click(".tab-write");
    assert.equal(await page.locator(".composer-input").inputValue(), "Keep this composer draft during profile import.");
    await page.fill(".composer-input", "");
    await page.click(".tab-settings");
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });

    await page.locator(".settings-profile-select").filter({
      has: page.locator("strong").filter({ hasText: new RegExp(`^${escapeRegExp(profileName)}$`, "u") })
    }).click();
    await page.click(".settings-reload");
    await page.waitForFunction(
      (expected) => document.querySelector(".settings-profile-select.active strong")?.textContent === expected,
      profileName,
      { timeout: 15_000 }
    );
    assert.equal(await page.locator(".settings-control-sampling-topP").inputValue(), "0.7");
    assert.equal(await page.locator(".settings-control-profile-temperature").inputValue(), "0.9");
    await page.waitForSelector(".settings-discard-pending", { timeout: 15_000 });
    const pendingNotice = await page.locator(".settings-pending-notice").innerText();
    assert.match(pendingNotice, /saved.*not active/isu);
    assert.match(pendingNotice, /provider check failed/isu);
    assert.match(pendingNotice, /retry activation/isu);
    assert.equal(await page.locator(".settings-save").innerText(), "Retry activation");

    await page.reload();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await page.click(".tab-settings");
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await page.locator(".settings-profile-select").filter({
      has: page.locator("strong").filter({ hasText: new RegExp(`^${escapeRegExp(profileName)}$`, "u") })
    }).click();
    assert.equal(await page.locator(".settings-control-sampling-topP").inputValue(), "0.7");
    assert.equal(await page.locator(".settings-control-profile-temperature").inputValue(), "0.9");
    assert.equal(await page.locator(".settings-control-sampling-stop").inputValue(), "END\nTHE END");
    assert.equal(await page.locator(".settings-control-profile-tokenProbabilities").inputValue(), "");
    assert.ok(await page.locator(".settings-profile-card").count() >= 2);

    await page.click(".settings-discard-pending");
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Pending settings discarded") === true
        || Boolean(document.querySelector(".settings-global-error")?.textContent),
      undefined,
      { timeout: 30_000 }
    );
    assert.deepEqual(await page.locator(".settings-global-error").allTextContents(), []);
    await page.waitForFunction(() => document.querySelector(".settings-discard-pending") === null, undefined, { timeout: 15_000 });
    assert.equal(await page.locator(".settings-profile-select.active strong").innerText(), "Default");
    assert.equal(await page.locator(".settings-control-profile-discardReasoning").isChecked(), true);

    await page.fill(".settings-control-connection-totalMs", "0");
    await page.waitForSelector(".settings-error", { timeout: 5_000 });
    assert.match(await page.locator(".settings-error").first().innerText(), /number|positive|whole/iu);
    assert.equal(await page.locator(".settings-save").isDisabled(), true);
    assert.match(await page.locator(".settings-save-validation").innerText(), /Fix 1 invalid field before saving/iu);
  } finally {
    await closeDesktopApp(app);
    await rm(dataDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(exportDir, { recursive: true, force: true });
  }
});

test("Electron restores the Settings editor after discarding a dirty story switch", async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-settings-switch-e2e-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-settings-switch-state-e2e-"));
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(stateDir, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_STATE: stateDir,
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStoryForSettings(page, "Settings story");
    await createStoryForSettings(page, "Other story");
    await goToLibrary(page);
    await page.locator(".story-row").filter({ hasText: "Settings story" }).click();
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "Settings story", undefined, { timeout: 15_000 });
    await page.click(".tab-settings");
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await page.fill(".settings-control-profile-maxOutputTokens", "1234");

    await goToLibrary(page);
    await page.locator(".story-row").filter({ hasText: "Other story" }).click();
    const discardDialog = page.locator('.modal-card[aria-label="Discard unsaved edits?"]');
    await discardDialog.waitFor({ state: "visible", timeout: 15_000 });
    await discardDialog.locator(".modal-submit").click();
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "Other story", undefined, { timeout: 30_000 });
    await page.click(".tab-settings");
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    assert.notEqual(await page.locator(".settings-control-profile-maxOutputTokens").inputValue(), "1234");
  } finally {
    await closeDesktopApp(app);
    await rm(dataDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Electron keeps discovery focus on the model card that was used", async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-settings-discovery-e2e-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-settings-discovery-state-e2e-"));
  const server = createServer((request, response) => {
    if (request.url !== "/v1/models") {
      response.writeHead(404);
      response.end("missing");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      data: [
        { id: "remote-alpha", name: "Remote Alpha", context_length: 8_192, max_output_tokens: 512 },
        { id: "remote-beta", name: "Remote Beta", context_length: 16_384, max_output_tokens: 1_024 }
      ]
    }));
  });
  const port = await listen(server);
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(stateDir, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_STATE: stateDir,
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStoryForSettings(page, "Discovery focus");
    await page.click(".tab-settings");
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    await page.click(".settings-connection-create");
    await page.selectOption(".settings-control-connection-preset", "custom");
    await page.selectOption(".settings-control-connection-protocol", "openai-chat-completions");
    await page.fill(".settings-control-connection-baseUrl", `http://127.0.0.1:${port}/v1`);
    await page.locator(".settings-control-connection-allowInsecureHttp").check();
    await page.click(".settings-discover");
    await page.waitForFunction(
      () => document.querySelectorAll(".settings-discovery-card").length === 2,
      undefined,
      { timeout: 30_000 }
    );

    await page.locator(".settings-discovery-card").nth(1).locator(".settings-model-use").click();
    assert.equal(await page.locator(".settings-control-model-remoteId").inputValue(), "remote-beta");
    assert.equal(await page.evaluate(() => {
      const cards = document.querySelectorAll(".settings-discovery-card");
      const active = document.activeElement;
      return active?.classList.contains("settings-model-use") === true && cards[1]?.contains(active) === true;
    }), true);

    await page.click(".settings-header-add");
    await page.click(".settings-header-add");
    assert.equal(await page.locator(".settings-header-row").count(), 2);
    await page.locator(".settings-header-row").nth(1).locator(".settings-header-remove").click();
    assert.equal(await page.evaluate(() => {
      const row = document.querySelector(".settings-header-row");
      return row?.contains(document.activeElement) === true;
    }), true);
  } finally {
    await closeDesktopApp(app);
    await closeServer(server);
    await rm(dataDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

async function waitForExport(directory: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const files = await readdir(directory);
    if (files.length > 0) return files[0]!;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Profile export did not appear in ${directory}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function typeSetting(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector);
  await input.click();
  await input.press("ControlOrMeta+A");
  await input.pressSequentially(value);
}

async function createStoryForSettings(page: Page, title: string): Promise<void> {
  await goToLibrary(page);
  await page.click(".new-story-button");
  await page.waitForSelector(".modal-card", { timeout: 15_000 });
  await page.fill(".modal-input", title);
  await page.click(".modal-submit");
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 15_000 });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Discovery server did not expose a port");
  return (address as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
