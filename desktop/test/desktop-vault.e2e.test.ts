import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron } from "playwright";
import { closeDesktopApp } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

test("Electron confirms, seals, and permanently unseals a project vault", { timeout: 180_000 }, async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-vault-e2e-"));
  const dataDir = path.join(directory, "project");
  const stateDir = path.join(directory, "machine");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_STATE: stateDir,
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await page.click(".new-story-button");
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.fill(".modal-input", "Vault proof");
    await page.click(".modal-submit");
    await page.waitForSelector(".story-title", { timeout: 30_000 });

    await page.click(".project-seal");
    await page.waitForSelector('.modal-card[aria-label="Choose a password to seal this project"]', { timeout: 15_000 });
    assert.equal(await page.locator("[data-dialog-field=password]").count(), 1);
    assert.equal(await page.locator("[data-dialog-field=repeatPassword]").count(), 1);
    assert.equal(await page.locator("[data-dialog-field=password]").getAttribute("type"), "password");
    assert.equal(await page.locator("[data-dialog-field=repeatPassword]").getAttribute("type"), "password");
    assert.match(await page.locator(".modal-card").innerText(), /encrypts and locks the project/u);

    await page.click(".modal-submit");
    await page.waitForSelector('.modal-card[aria-label="Password required"]', { timeout: 15_000 });
    assert.equal(await page.locator(".launcher-page").count(), 0);
    await page.click(".modal-submit");
    await page.waitForSelector('.modal-card[aria-label="Choose a password to seal this project"]', { timeout: 15_000 });

    await page.fill('[data-dialog-field="password"]', "vault-password");
    await page.fill('[data-dialog-field="repeatPassword"]', "different-password");
    await page.click(".modal-submit");
    await page.waitForSelector('.modal-card[aria-label="Passwords do not match"]', { timeout: 15_000 });
    assert.equal(await page.locator(".launcher-page").count(), 0);
    await page.click(".modal-submit");
    await page.waitForSelector('.modal-card[aria-label="Choose a password to seal this project"]', { timeout: 15_000 });

    await page.fill('[data-dialog-field="password"]', "vault-password");
    await page.fill('[data-dialog-field="repeatPassword"]', "vault-password");
    await page.click(".modal-submit");
    await page.waitForSelector(".vault-panel", { timeout: 30_000 });
    assert.equal(await page.getByRole("button", { name: "Unlock project" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Unseal permanently" }).count(), 1);

    await page.fill(".launcher-input", "vault-password");
    await page.getByRole("button", { name: "Unseal permanently" }).click();
    await page.waitForSelector(".story-title", { timeout: 30_000 });
    assert.equal(await page.locator(".story-title").innerText(), "Vault proof");

    await page.click(".project-seal");
    await page.waitForSelector('.modal-card[aria-label="Choose a password to seal this project"]', { timeout: 15_000 });
    await page.fill('[data-dialog-field="password"]', "vault-password");
    await page.fill('[data-dialog-field="repeatPassword"]', "vault-password");
    await page.click(".modal-submit");
    await page.waitForSelector(".vault-panel", { timeout: 30_000 });

    const vaultPassword = page.locator('input[aria-label="Vault password"]');
    await vaultPassword.fill("wrong-vault-password");
    await page.getByRole("button", { name: "Unseal permanently" }).click();
    await page.waitForFunction(
      () => (document.querySelector(".launcher-error")?.textContent?.trim().length ?? 0) > 0,
      undefined,
      { timeout: 30_000 }
    );
    assert.equal(await vaultPassword.inputValue(), "wrong-vault-password");
    assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Vault password");
    await vaultPassword.fill("vault-password");
    await page.getByRole("button", { name: "Unseal permanently" }).click();
    await page.waitForSelector(".story-title", { timeout: 30_000 });

    await page.click(".project-seal");
    await page.waitForSelector('.modal-card[aria-label="Choose a password to seal this project"]', { timeout: 15_000 });
    await page.fill('[data-dialog-field="password"]', "vault-password");
    await page.fill('[data-dialog-field="repeatPassword"]', "vault-password");
    await page.click(".modal-submit");
    await page.waitForSelector(".vault-panel", { timeout: 30_000 });

    await vaultPassword.fill("wrong-vault-password");
    await page.getByRole("button", { name: "Unlock project" }).click();
    await page.waitForFunction(
      () => (document.querySelector(".launcher-error")?.textContent?.trim().length ?? 0) > 0,
      undefined,
      { timeout: 30_000 }
    );
    assert.equal(await vaultPassword.inputValue(), "wrong-vault-password");
    assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Vault password");
    await vaultPassword.fill("vault-password");
    await page.getByRole("button", { name: "Unlock project" }).click();
    await page.waitForSelector(".story-title", { timeout: 30_000 });
    assert.equal(await page.locator(".story-title").innerText(), "Vault proof");
    await page.waitForSelector(".project-unseal", { timeout: 15_000 });
    await page.locator(".composer-input").fill("Keep this direction after a wrong vault password.");
    await page.click(".project-unseal");
    await page.waitForSelector('.modal-card[aria-label="Unseal project"]', { timeout: 15_000 });
    await page.fill(".modal-input", "wrong-password");
    await page.click(".modal-submit");
    await page.waitForSelector('.modal-card[aria-label="Discard unsaved edits?"]', { timeout: 15_000 });
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelector(".topbar-status")?.textContent?.includes("Host action failed") === true,
      undefined, { timeout: 30_000 });
    await page.locator(".tab-settings").click();
    await page.locator(".tab-write").click();
    assert.equal(await page.locator(".composer-input").inputValue(), "Keep this direction after a wrong vault password.");
    await page.locator(".composer-input").fill("");
    await page.click(".project-unseal");
    await page.waitForSelector('.modal-card[aria-label="Unseal project"]', { timeout: 15_000 });
    assert.match(await page.locator(".modal-card").innerText(), /remove encryption permanently/iu);
    await page.fill(".modal-input", "vault-password");
    await page.click(".modal-submit");
    await page.waitForSelector(".project-seal", { timeout: 30_000 });
    await page.waitForSelector(".story-title", { timeout: 30_000 });
    assert.equal(await page.locator(".story-title").innerText(), "Vault proof");
    assert.equal(await page.locator(".project-seal").count(), 1);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});
