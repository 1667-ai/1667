import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is a required dependency of the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { closeDesktopApp } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

async function assertStoryLayout(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
  }, { width, height });
  await page.waitForTimeout(150);
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, scrollWidth: document.documentElement.scrollWidth }));
  const menu = await page.locator(".story-menu").boundingBox();
  const title = await page.locator(".story-title").boundingBox();
  const status = await page.locator(".topbar-status").boundingBox();
  const topbarActions = await page.locator(".topbar-actions").boundingBox();
  assert.ok(menu, `story actions must render at ${width}x${height}`);
  assert.ok(title && title.width > 260, `story title must retain readable width at ${width}x${height}`);
  assert.ok(viewport.scrollWidth <= viewport.width + 1, `story layout must not overflow at ${width}x${height}`);
  assert.ok(menu!.x >= 0 && menu!.x + menu!.width <= viewport.width + 1, `story actions must stay in the viewport at ${width}x${height}`);
  assert.ok(menu!.y >= 0 && menu!.y + menu!.height <= viewport.height + 1, `story actions must stay above the fold at ${width}x${height}`);
  assert.ok(status && status.x >= 0 && status.x + status.width <= viewport.width + 1, `status must stay in the viewport at ${width}x${height}`);
  if (width <= 1180) assert.ok(status && status.width >= 175, `status must retain readable width at ${width}x${height}`);
  assert.ok(topbarActions && topbarActions.x >= 0 && topbarActions.x + topbarActions.width <= viewport.width + 1, `topbar actions must stay in the viewport at ${width}x${height}`);
  assert.equal(await page.locator(".topbar-status").getAttribute("title"), await page.locator(".topbar-status").innerText());
  const buttons = await page.locator(".story-menu .button").evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  }));
  assert.equal(buttons.length, 8);
  for (const button of buttons) {
    assert.ok(button.left >= 0 && button.right <= viewport.width + 1, `story action button must stay in the viewport at ${width}x${height}`);
    assert.ok(button.top >= 0 && button.bottom <= viewport.height + 1, `story action button must stay visible at ${width}x${height}`);
  }
  const rail = await page.locator(".context-rail").boundingBox();
  if (rail !== null && rail.y < menu!.y + menu!.height) {
    assert.ok(menu!.x + menu!.width <= rail.x + 1, `story actions must stay left of the context rail at ${width}x${height}`);
  }
}

async function assertLongStatusLayout(app: ElectronApplication, page: Page, restoreText: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
  await page.waitForTimeout(150);
  await page.locator(".part-text").last().fill("A narrow layout status probe.");
  await page.fill(".composer-input", "status probe");
  await page.click(".composer-submit");
  await page.waitForFunction(
    () => document.querySelector(".topbar-status")?.textContent?.includes("Save the active part first") === true,
    { timeout: 15_000 }
  );
  const viewport = await page.evaluate(() => ({ width: window.innerWidth }));
  const status = await page.locator(".topbar-status").boundingBox();
  const actions = await page.locator(".topbar-actions").boundingBox();
  assert.ok(status && status.x + status.width <= viewport.width + 1, "long status must stay in the viewport");
  assert.ok(actions && actions.x + actions.width <= viewport.width + 1, "actions must stay in the viewport beside long status");
  await page.locator(".part-save").last().click();
  await page.waitForFunction(() => document.querySelector(".topbar-status")?.textContent?.includes("Saved") === true, { timeout: 15_000 });
  await page.locator(".part-text").last().fill(restoreText);
  await page.locator(".part-save").last().click();
  await page.waitForFunction(() => document.querySelector(".topbar-status")?.textContent?.includes("Saved") === true, { timeout: 15_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 900));
  await page.waitForTimeout(150);
}

test("Electron Renderer drives a dry-run story through the Host", async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-e2e-"));
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
    await page.click(".new-story-button");
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.fill(".modal-input", "The keeper of the quiet sea");
    await page.click(".modal-submit");
    await page.waitForFunction(
      () => document.querySelector(".story-title")?.textContent?.includes("The keeper of the quiet sea") === true,
      { timeout: 30_000 }
    );
    assert.equal(await page.locator(".story-title").innerText(), "The keeper of the quiet sea");
    await page.locator(".project-browser").click();
    await page.waitForSelector(".launcher-page", { timeout: 15_000 });
    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector(".updater-message")?.textContent?.includes("development build") === true,
      undefined, { timeout: 15_000 }
    );
    await page.locator(".updater-channel").selectOption("beta");
    await page.waitForFunction(
      () => document.querySelector(".updater-message")?.textContent?.includes("beta desktop update") === true,
      undefined, { timeout: 15_000 }
    );
    assert.equal(await page.locator(".updater-channel").inputValue(), "beta");
    assert.equal(await page.getByRole("button", { name: "Back to story" }).count(), 1);
    await page.getByRole("button", { name: "Back to story" }).click();
    await page.waitForSelector(".story-title", { timeout: 15_000 });
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".story-title").innerText(), "The keeper of the quiet sea");
    assert.equal(await page.locator(".project-reveal").innerText(), "Reveal folder");
    await assertStoryLayout(app, page, 1280, 900);
    await assertStoryLayout(app, page, 960, 640);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 900));
    await page.waitForTimeout(150);

    const search = page.locator(".library-search");
    await search.focus();
    await search.pressSequentially("Desk", { delay: 20 });
    assert.equal(await search.inputValue(), "Desk");
    assert.equal(await page.locator(":focus").getAttribute("data-preserve"), "search");
    await search.fill("");

    await page.fill(".composer-input", "Opening line");
    await page.click(".composer-manual");
    await page.waitForSelector(".manuscript-part", { timeout: 15_000 });
    const manualText = "  A hand written opening line.  ";
    await page.fill(".composer-input", manualText);
    await page.click(".composer-manual");
    await page.waitForFunction(
      () => document.querySelectorAll(".manuscript-part").length >= 2,
      { timeout: 15_000 }
    );
    const part = page.locator(".part-text").last();
    assert.equal(await part.inputValue(), manualText.trim());
    const savedPartText = await part.inputValue();
    await page.fill(".composer-input", "draft repaint probe");
    assert.equal(await part.inputValue(), savedPartText, "composer draft updates must retain saved prose");
    const note = page.locator(".rail-textarea").nth(0);
    await note.fill("note repaint probe");
    assert.equal(await part.inputValue(), savedPartText, "Author's Note draft updates must retain saved prose");
    const brief = page.locator(".rail-textarea").nth(1);
    await brief.fill("brief repaint probe");
    assert.equal(await part.inputValue(), savedPartText, "Author Brief draft updates must retain saved prose");
    await page.fill(".composer-input", "");
    await note.fill("");
    await brief.fill("");
    const editedText = "  A hand edited opening line.  ";
    await part.fill(editedText);
    await page.locator(".part-save").last().click();
    await page.waitForFunction(
      () => document.querySelector(".topbar-status")?.textContent?.includes("Saved") === true,
      { timeout: 15_000 }
    );
    assert.equal(await part.inputValue(), editedText);
    await part.fill(editedText);
    await page.waitForFunction(
      () => document.querySelector(".story-save-state")?.textContent === "saved",
      { timeout: 5_000 }
    );
    await assertLongStatusLayout(app, page, editedText);

    await page.locator(".composer-mode").selectOption("direct");
    const requestDetails = page.locator(".request-details");
    await requestDetails.locator("summary").click();
    await page.fill(".composer-input", "preserve the request context");
    assert.notEqual(await requestDetails.getAttribute("open"), null);
    await page.waitForTimeout(500);
    if (await requestDetails.getAttribute("open") !== null) await requestDetails.locator("summary").click();
    await requestDetails.locator("summary").click();
    await page.waitForFunction(
      () => [...document.querySelectorAll(".request-message-text")].some((element) => element.textContent?.includes("preserve the request context") === true),
      { timeout: 15_000 }
    );
    assert.ok((await page.locator(".request-message-text").allTextContents()).some((text) => text.includes("preserve the request context")));
    await page.fill(".composer-input", "");
    const shortcut = process.platform === "darwin" ? "Meta" : "Control";
    await page.locator(".composer-input").press(`${shortcut}+2`);
    await page.waitForSelector(".tab-content.facts", { timeout: 15_000 });
    await page.keyboard.press(`${shortcut}+1`);
    await page.waitForSelector(".tab-content.write", { timeout: 15_000 });
    const cdp = await page.context().newCDPSession(page);
    const imeInput = page.locator(".composer-input");
    await imeInput.fill("");
    await imeInput.focus();
    await cdp.send("Input.imeSetComposition", { text: "仮", selectionStart: 1, selectionEnd: 1 });
    assert.equal(await page.locator(":focus").getAttribute("data-preserve"), "composer");
    await cdp.send("Input.insertText", { text: "名" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-preserve") === "composer", { timeout: 5_000 });
    assert.ok((await imeInput.inputValue()).length > 0);
    await imeInput.fill("");
    const theme = page.locator(".theme-select");
    await theme.selectOption("graphite");
    assert.equal(await page.locator("html").getAttribute("data-desktop-theme"), "graphite");
    await theme.selectOption("parchment");
    const directions = page.locator(".directions-toggle");
    const directionsBefore = await directions.getAttribute("aria-pressed");
    await directions.click();
    assert.notEqual(await directions.getAttribute("aria-pressed"), directionsBefore);
    await directions.click();

    await page.click(".new-story-button");
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.fill(".modal-input", "Draft destination");
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "Draft destination", { timeout: 15_000 });
    const originalRow = page.locator(".story-row").filter({ hasText: "The keeper of the quiet sea" });
    const destinationRow = page.locator(".story-row").filter({ hasText: "Draft destination" });
    await originalRow.click();
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "The keeper of the quiet sea", { timeout: 15_000 });
    const dirtyPart = page.locator(".part-text").last();
    await dirtyPart.fill("Keep this unsaved sentence.");
    await destinationRow.click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    assert.equal(await page.locator(".modal-card h2").innerText(), "Discard unsaved edits?");
    await page.click(".modal-cancel");
    assert.equal(await page.locator(".story-title").innerText(), "The keeper of the quiet sea");
    assert.equal(await page.locator(".part-text").last().inputValue(), "Keep this unsaved sentence.");
    await destinationRow.click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "Draft destination", { timeout: 15_000 });
    await originalRow.click();
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "The keeper of the quiet sea", { timeout: 15_000 });
    await page.waitForFunction(
      () => /Story loaded|Aside unavailable/u.test(document.querySelector(".topbar-status")?.textContent ?? ""),
      { timeout: 15_000 }
    );

    await page.waitForTimeout(500);
    const selectionStart = editedText.indexOf("hand");
    await part.evaluate((element, start) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.focus();
      textarea.setSelectionRange(start, start + "hand".length);
    }, selectionStart);
    assert.deepEqual(await part.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      return [textarea.selectionStart, textarea.selectionEnd];
    }), [selectionStart, selectionStart + "hand".length]);
    assert.deepEqual(await page.locator(".part-rewrite").last().evaluate((button) => {
      const textarea = button.closest(".manuscript-part")?.querySelector(".part-text") as HTMLTextAreaElement | null;
      return textarea === null ? null : [textarea.selectionStart, textarea.selectionEnd, textarea.value];
    }), [selectionStart, selectionStart + "hand".length, editedText]);
    await page.locator(".part-rewrite").last().click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    assert.match(await page.locator(".modal-card h2").innerText(), /Rewrite selection/);
    await page.fill(".modal-input", "make this word vivid");
    await page.click(".modal-submit");
    await page.waitForFunction(
      () => document.querySelector(".topbar-status")?.textContent?.includes("Saved") === true,
      { timeout: 30_000 }
    );

    await page.fill(".composer-input", "let the dry-run lantern answer");
    await page.click(".composer-submit");
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await part.fill("A draft held while the Host streams.");
    assert.equal(await page.locator(":focus").getAttribute("data-preserve"), await part.getAttribute("data-preserve"));
    await page.click(".stream-stop");
    await page.locator(".stream-card").waitFor({ state: "detached", timeout: 30_000 });
    assert.equal(await page.locator(".part-text").last().inputValue(), "A draft held while the Host streams.");

    const composerMode = page.locator(".composer-mode");
    await composerMode.selectOption("direct");
    assert.match(await page.locator(".composer-submit").innerText(), /Write take/);
    await page.fill(".composer-input", "keep this direction visible");
    assert.equal(await composerMode.inputValue(), "direct");
    await page.click(".composer-submit");
    await page.waitForFunction(
      () => document.querySelector(".topbar-status")?.textContent?.includes("Save the active part first") === true,
      { timeout: 15_000 }
    );
    assert.equal(await page.locator(".stream-card").count(), 0);

    await page.locator(".part-save").last().click();
    await page.waitForFunction(
      () => document.querySelector(".topbar-status")?.textContent?.includes("Saved") === true,
      { timeout: 15_000 }
    );
    await page.locator(".part-switch").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, { timeout: 15_000 });
    await composerMode.selectOption("direct");
    await page.fill(".composer-input", "start a retained branch");
    await page.click(".composer-submit");
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector(".stream-card") === null, { timeout: 30_000 });
    assert.match(await page.locator(".part-badges").last().innerText(), /2 takes/iu);

    const factSource = await part.inputValue();
    assert.ok(factSource.length >= 4, "Fact selection probe needs saved prose");
    await part.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.focus();
      textarea.setSelectionRange(0, 4);
    });
    await page.locator(".part-fact-selection").last().click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    assert.equal(await page.locator(".modal-card h2").innerText(), "Fact name");
    await page.fill(".modal-input", "Selected prose");
    await page.click(".modal-submit");
    await page.waitForSelector(".modal-textarea", { timeout: 15_000 });
    assert.equal(await page.locator(".modal-textarea").inputValue(), factSource.slice(0, 4));
    await page.fill(".modal-textarea", "Selected prose is durable.");
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelector(".topbar-status")?.textContent?.includes("Done") === true, { timeout: 15_000 });

    await page.locator(".part-fact-here").last().click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.fill(".modal-input", "Active part");
    await page.click(".modal-submit");
    await page.fill(".modal-textarea", "The active part anchors this Fact.");
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelector(".topbar-status")?.textContent?.includes("Done") === true, { timeout: 15_000 });

    await page.click(".tab-facts");
    await page.waitForSelector(".new-fact", { timeout: 15_000 });
    assert.equal(await page.locator(".fact-card").count(), 2);
    const selectedFact = page.locator(".fact-card").first();
    assert.equal((await selectedFact.locator(".fact-tag").innerText()).toLowerCase(), "no tag");
    await selectedFact.locator(".fact-states summary").click();
    assert.match(await selectedFact.locator(".fact-state-meta").first().innerText(), /after /iu);
    await selectedFact.locator(".fact-state-edit").click();
    await page.waitForSelector(".modal-fields", { timeout: 15_000 });
    await page.fill("[data-dialog-field=text]", "");
    await page.selectOption("[data-dialog-field=scope]", "Story-wide");
    await page.selectOption("[data-dialog-field=ends]", "Yes");
    await page.click(".modal-submit");
    await page.waitForFunction(() => [...document.querySelectorAll(".fact-state-copy strong")].some((element) => element.textContent === "End State"), { timeout: 15_000 });
    assert.equal(await selectedFact.locator(".fact-state-edit").count(), 1, "End states must remain editable");
    await selectedFact.locator(".fact-state-edit").click();
    await page.waitForSelector(".modal-fields", { timeout: 15_000 });
    await page.fill("[data-dialog-field=text]", "Reanchored prose");
    await page.selectOption("[data-dialog-field=scope]", "After active part");
    await page.selectOption("[data-dialog-field=ends]", "No");
    await page.click(".modal-submit");
    await page.waitForFunction(() => [...document.querySelectorAll(".fact-state-copy strong")].some((element) => element.textContent === "Reanchored prose"), { timeout: 15_000 });
    assert.match(await selectedFact.locator(".fact-state-meta").first().innerText(), /after /iu);

    await page.click(".new-fact");
    await page.fill(".modal-input", "Compass");
    await page.click(".modal-submit");
    await page.fill(".modal-input", "A north point for the manuscript.");
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelectorAll(".fact-card").length >= 3, { timeout: 15_000 });
    await page.locator(".fact-edit").last().click();
    await page.waitForSelector(".modal-fields", { timeout: 15_000 });
    await page.fill("[data-dialog-field=name]", "North star");
    await page.fill("[data-dialog-field=tag]", "place");
    await page.click(".modal-submit");
    await page.waitForFunction(
      () => [...document.querySelectorAll(".fact-card h3")].at(-1)?.textContent?.includes("North star") === true,
      { timeout: 15_000 }
    );
    assert.match(await page.locator(".fact-card").last().locator("h3").innerText(), /North star/);
    await page.click(".tab-chapters");
    await page.waitForSelector(".new-chapter", { timeout: 15_000 });
    await page.click(".tab-settings");
    await page.waitForSelector(".settings-panel", { timeout: 15_000 });
    assert.equal(await page.locator(".settings-panel").isVisible(), true);
    await page.waitForSelector(".settings-editor", { timeout: 15_000 });
    const temperature = page.locator('[data-settings-field="profile.temperature"]');
    await temperature.fill("0.7");
    await page.click(".settings-save");
    await page.waitForFunction(
      () => document.querySelector(".topbar-status")?.textContent?.includes("Settings saved") === true,
      { timeout: 15_000 }
    );
    assert.equal(await temperature.inputValue(), "0.7");

    await page.click(".tab-write");
    assert.ok(await page.locator(".manuscript-part").count() >= 2);
    await page.locator(".part-text").last().fill("A draft in the descendant being deleted.");
    await page.locator(".part-delete").first().click();
    await page.locator('.modal-card[aria-label="Delete part"] .modal-submit').click();
    await page.waitForFunction(
      () => document.querySelectorAll(".manuscript-part").length === 0,
      undefined, { timeout: 15_000 }
    );
    assert.equal((await page.locator(".story-save-state").innerText()).toLowerCase(), "saved");
    await destinationRow.click();
    await page.waitForFunction(
      () => document.querySelector(".story-title")?.textContent === "Draft destination",
      undefined, { timeout: 15_000 }
    );
    assert.equal(await page.locator(".modal-card").count(), 0);

    const sealed = await page.evaluate(async () => {
      const response = await window.desktop?.shell?.request({ type: "vault.seal", password: "desktop-e2e-password" });
      return response?.ok === true;
    });
    assert.equal(sealed, true);
    await page.waitForSelector(".launcher-page", { timeout: 15_000 });
    await page.evaluate(() => {
      void window.desktop?.shell?.request({ type: "auth.login", provider: "chatgpt" });
    });
    await page.waitForSelector(".auth-prompt .launcher-input", { timeout: 15_000 });
    const authInput = page.locator(".auth-prompt .launcher-input");
    await authInput.selectOption("no");
    assert.equal(await authInput.inputValue(), "no");
    await page.locator(".auth-prompt button", { hasText: "Continue" }).click();
    await page.waitForFunction(() => document.querySelector(".auth-prompt") === null, { timeout: 15_000 });
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});
