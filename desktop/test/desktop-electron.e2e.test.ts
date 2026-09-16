import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is a required dependency of the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright";
import { closeDesktopApp, editPart, goToLibrary } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

/** Phase 3: double-clicks a specific part's card (not by index) into edit
 * mode. `editPart` in the shared helper indexes `.manuscript-part` by
 * position, which this file cannot always use once a stable card (found by
 * `data-preserve`) needs re-editing after it stops being the last or first
 * part on the page. */
async function editPartIn(card: Locator): Promise<Locator> {
  const text = card.locator(".part-text");
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await card.locator(".part-prose").dblclick({ timeout: 3_000 });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      continue;
    }
    try {
      await text.waitFor({ state: "visible", timeout: 1_500 });
      return text;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
  }
}

/** Opens the `···` overflow menu for a part card, waiting for the popover. */
async function openPartMenu(card: Locator, page: Page): Promise<void> {
  await card.locator(".part-prose").hover();
  await card.locator(".part-more").click();
  await page.waitForSelector(".part-menu", { timeout: 15_000 });
}

async function assertStoryLayout(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
  }, { width, height });
  await page.waitForTimeout(150);
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, scrollWidth: document.documentElement.scrollWidth }));
  const title = await page.locator(".story-title").boundingBox();
  const titlebar = await page.locator(".titlebar").boundingBox();
  const rail = await page.locator(".rail").boundingBox();
  assert.ok(title && title.width > 60, `story title must retain readable width at ${width}x${height}`);
  assert.ok(viewport.scrollWidth <= viewport.width + 1, `story layout must not overflow at ${width}x${height}`);
  assert.ok(titlebar && Math.round(titlebar.height) === 44, `titlebar must stay 44px tall at ${width}x${height}`);
  assert.ok(rail && Math.round(rail.width) === 56, `rail must stay 56px wide at ${width}x${height}`);
  assert.equal(await page.locator(".toast").getAttribute("title"), await page.locator(".toast").innerText());
}

async function assertLongStatusLayout(app: ElectronApplication, page: Page, partCard: Locator, restoreText: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
  await page.waitForTimeout(150);
  const first = await editPartIn(partCard);
  await first.fill("A narrow layout status probe.");
  await page.fill(".composer-input", "status probe");
  await page.click(".composer-submit");
  await page.waitForFunction(
    () => document.querySelector(".toast")?.textContent?.includes("Save the active part first") === true,
    { timeout: 15_000 }
  );
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.ok(!overflows, "a long toast message must not cause horizontal overflow");
  await page.locator(".part-save").click();
  await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Saved") === true, { timeout: 15_000 });
  const second = await editPartIn(partCard);
  await second.fill(restoreText);
  await page.locator(".part-save").click();
  await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Saved") === true, { timeout: 15_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 900));
  await page.waitForTimeout(150);
}

/** Selects `[start, start + length)` of a `.part-prose` node's single text
 * node — the prose is a literal, markup-free rendering of the part's text,
 * so these offsets line up 1:1 with the story text (see `proseSelection` in
 * `renderer-manuscript-view.ts`). */
async function selectProseRange(prose: Locator, start: number, length: number): Promise<void> {
  await prose.evaluate((element, args) => {
    const textNode = element.firstChild;
    if (textNode === null) return;
    const range = document.createRange();
    range.setStart(textNode, args.start);
    range.setEnd(textNode, args.start + args.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    if (selection !== null) selection.addRange(range);
  }, { start, length });
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
    await goToLibrary(page);
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

    await page.locator(".tab-write").click();
    await page.waitForSelector(".composer-input", { timeout: 15_000 });
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

    // `activePart` is the second (most recently written) part, tracked by
    // its stable `data-preserve` card key rather than DOM position — the
    // streaming placeholder later in this test also carries the
    // `.manuscript-part` class (D-09/D-14), so position alone is not safe.
    const createdPart = page.locator(".manuscript-part").last();
    const activePartCardKey = await createdPart.getAttribute("data-preserve");
    assert.ok(activePartCardKey, "the saved part must have a stable card key");
    // A *stable* reference by card key, not a re-resolving `.last()` — the
    // streaming placeholder also carries `.manuscript-part` (D-09/D-14), and
    // this part stops being the last (or first) one well before this test
    // is done with it.
    const activePart = page.locator(`[data-preserve="${activePartCardKey}"]`);
    const activeProse = activePart.locator(".part-prose");
    assert.equal(await activeProse.textContent(), manualText.trim());
    const savedPartText = await activeProse.textContent();
    await page.fill(".composer-input", "draft repaint probe");
    assert.equal(await activeProse.textContent(), savedPartText, "composer draft updates must retain saved prose");
    const note = page.locator(".rail-textarea").nth(0);
    await note.fill("note repaint probe");
    assert.equal(await activeProse.textContent(), savedPartText, "Author's Note draft updates must retain saved prose");
    const brief = page.locator(".rail-textarea").nth(1);
    await brief.fill("brief repaint probe");
    assert.equal(await activeProse.textContent(), savedPartText, "Author Brief draft updates must retain saved prose");
    await page.fill(".composer-input", "");
    await note.fill("");
    await brief.fill("");
    const editedText = "  A hand edited opening line.  ";
    const firstEdit = await editPartIn(activePart);
    await firstEdit.fill(editedText);
    await page.locator(".part-save").click();
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Saved") === true,
      { timeout: 15_000 }
    );
    assert.equal(await activeProse.textContent(), editedText);
    const secondEdit = await editPartIn(activePart);
    await secondEdit.fill(editedText);
    await page.waitForFunction(
      () => document.querySelector(".story-save-state")?.textContent === "saved",
      { timeout: 5_000 }
    );
    await page.keyboard.press("Escape");
    await page.waitForSelector(".part-text", { state: "detached", timeout: 15_000 });
    await assertLongStatusLayout(app, page, activePart, editedText);

    await page.locator(".composer-mode-direct").click();
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
    await page.locator(".composer-input").press(`${shortcut}+3`);
    await page.waitForSelector(".tab-content.facts", { timeout: 15_000 });
    await page.keyboard.press(`${shortcut}+2`);
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
    await page.locator(".tab-settings").click();
    await page.waitForSelector(".theme-select", { timeout: 15_000 });
    const theme = page.locator(".theme-select");
    await theme.selectOption("graphite");
    assert.equal(await page.locator("html").getAttribute("data-desktop-theme"), "graphite");
    await theme.selectOption("parchment");
    const directions = page.locator(".directions-toggle");
    const directionsBefore = await directions.getAttribute("aria-pressed");
    await directions.click();
    assert.notEqual(await directions.getAttribute("aria-pressed"), directionsBefore);
    await directions.click();

    await goToLibrary(page);
    await page.click(".new-story-button");
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.fill(".modal-input", "Draft destination");
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "Draft destination", { timeout: 15_000 });
    const originalRow = page.locator(".story-row").filter({ hasText: "The keeper of the quiet sea" });
    const destinationRow = page.locator(".story-row").filter({ hasText: "Draft destination" });
    await goToLibrary(page);
    await originalRow.click();
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "The keeper of the quiet sea", { timeout: 15_000 });
    await page.locator(".tab-write").click();
    await page.waitForSelector(".part-prose", { timeout: 15_000 });
    const dirtyEdit = await editPartIn(activePart);
    await dirtyEdit.fill("Keep this unsaved sentence.");
    await goToLibrary(page);
    await destinationRow.click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    assert.equal(await page.locator(".modal-card h2").innerText(), "Discard unsaved edits?");
    await page.click(".modal-cancel");
    assert.equal(await page.locator(".story-title").innerText(), "The keeper of the quiet sea");
    await page.locator(".tab-write").click();
    await page.waitForSelector(".part-text", { timeout: 15_000 });
    assert.equal(await page.locator(".part-text").last().inputValue(), "Keep this unsaved sentence.");
    await goToLibrary(page);
    await destinationRow.click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "Draft destination", { timeout: 15_000 });
    await goToLibrary(page);
    await originalRow.click();
    await page.waitForFunction(() => document.querySelector(".story-title")?.textContent === "The keeper of the quiet sea", { timeout: 15_000 });
    await page.waitForFunction(
      () => /Story loaded|Aside unavailable/u.test(document.querySelector(".toast")?.textContent ?? ""),
      { timeout: 15_000 }
    );
    await page.locator(".tab-write").click();
    await page.waitForSelector(".part-prose", { timeout: 15_000 });
    // `editingPartId` is renderer state, not per-story, and this story reload
    // does not reset it (a suspected source-side gap — see the report below).
    // The discarded draft's part can come back showing `.part-text` again
    // even though nothing here re-entered edit mode; leave it if so.
    if (await activePart.locator(".part-text").count() > 0) {
      await page.keyboard.press("Escape");
      await activeProse.waitFor({ state: "visible", timeout: 15_000 });
    }

    await page.waitForTimeout(500);
    const currentSavedText = (await activeProse.textContent()) ?? "";
    const selectionStart = currentSavedText.indexOf("hand");
    assert.ok(selectionStart >= 0, "the saved part must still contain the word 'hand'");
    await selectProseRange(activeProse, selectionStart, "hand".length);
    await activeProse.hover();
    await activePart.locator(".part-rewrite").click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    assert.match(await page.locator(".modal-card h2").innerText(), /Rewrite selection/);
    await page.fill(".modal-input", "make this word vivid");
    await page.click(".modal-submit");
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Saved") === true,
      { timeout: 30_000 }
    );

    await page.fill(".composer-input", "let the dry-run lantern answer");
    const originalPartKey = `part:${activePartCardKey.slice("part-card:".length)}`;
    const originalPartId = activePartCardKey.slice("part-card:".length);
    const originalPartCard = activePart;
    await page.click(".composer-submit");
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForFunction(
      () => (document.querySelector(".stream-text")?.textContent?.length ?? 0) > 8,
      undefined,
      { timeout: 30_000 }
    );
    const originalPart = await editPartIn(originalPartCard);
    await originalPart.fill("A draft held while the Host streams.");
    assert.equal(await page.locator(":focus").getAttribute("data-preserve"), originalPartKey);
    await page.click(".stream-stop");
    await page.locator(".stream-card").waitFor({ state: "detached", timeout: 30_000 });
    assert.equal(await originalPart.inputValue(), "A draft held while the Host streams.");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".part-text", { state: "detached", timeout: 15_000 });
    await openPartMenu(originalPartCard, page);
    await page.locator(".part-menu .part-switch").click();
    await page.waitForFunction(
      (expected) => document.querySelector(".manuscript-part.active")?.getAttribute("data-preserve") === expected,
      `part-card:${originalPartId}`,
      { timeout: 15_000 }
    );

    await page.locator(".composer-mode-direct").click();
    assert.match(await page.locator(".composer-submit").innerText(), /Write take/);
    await page.fill(".composer-input", "keep this direction visible");
    assert.equal(await page.locator(".composer-mode-direct").evaluate((element) => element.classList.contains("active")), true);
    await page.click(".composer-submit");
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Save the active part first") === true,
      { timeout: 15_000 }
    );
    assert.equal(await page.locator(".stream-card").count(), 0);

    await editPartIn(originalPartCard);
    await page.locator(".part-save").click();
    await page.waitForFunction(
      () => document.querySelector(".toast")?.textContent?.includes("Saved") === true,
      { timeout: 15_000 }
    );
    const openingCard = page.locator(".manuscript-part").first();
    await openPartMenu(openingCard, page);
    await page.locator(".part-menu .part-switch").click();
    await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 1, { timeout: 15_000 });
    await page.locator(".composer-mode-direct").click();
    await page.fill(".composer-input", "start a retained branch");
    await page.click(".composer-submit");
    await page.waitForSelector(".stream-card", { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector(".stream-card") === null, { timeout: 30_000 });
    assert.match(await page.locator(".part-gutter-waymark").last().innerText(), /×2/u);

    const soleCard = page.locator(".manuscript-part").last();
    const soleProse = soleCard.locator(".part-prose");
    const factSource = (await soleProse.textContent()) ?? "";
    assert.ok(factSource.length >= 4, "Fact selection probe needs saved prose");
    await selectProseRange(soleProse, 0, 4);
    await openPartMenu(soleCard, page);
    await page.locator(".part-menu .part-fact-selection").click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    assert.equal(await page.locator(".modal-card h2").innerText(), "Fact name");
    await page.fill(".modal-input", "Selected prose");
    await page.click(".modal-submit");
    await page.waitForSelector(".modal-textarea", { timeout: 15_000 });
    assert.equal(await page.locator(".modal-textarea").inputValue(), factSource.slice(0, 4));
    await page.fill(".modal-textarea", "Selected prose is durable.");
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Done") === true, { timeout: 15_000 });

    await openPartMenu(soleCard, page);
    await page.locator(".part-menu .part-fact-here").click();
    await page.waitForSelector(".modal-card", { timeout: 15_000 });
    await page.fill(".modal-input", "Active part");
    await page.click(".modal-submit");
    await page.fill(".modal-textarea", "The active part anchors this Fact.");
    await page.click(".modal-submit");
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Done") === true, { timeout: 15_000 });

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
      () => document.querySelector(".toast")?.textContent?.includes("Settings saved") === true,
      { timeout: 15_000 }
    );
    assert.equal(await temperature.inputValue(), "0.7");

    await page.click(".tab-write");
    assert.ok(await page.locator(".manuscript-part").count() >= 2);
    const lastPartText = await editPart(page, "last");
    await lastPartText.fill("A draft in the descendant being deleted.");
    const firstCard = page.locator(".manuscript-part").first();
    await openPartMenu(firstCard, page);
    await page.locator(".part-menu .part-delete").click();
    await page.locator('.modal-card[aria-label="Delete part"] .modal-submit').click();
    await page.waitForFunction(
      () => document.querySelectorAll(".manuscript-part").length === 0,
      undefined, { timeout: 15_000 }
    );
    assert.equal((await page.locator(".story-save-state").innerText()).toLowerCase(), "saved");
    await goToLibrary(page);
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
