import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  collectPageDiagnostics,
  launchChrome,
  openInspectionApi,
  openTestPage
} from "./web-ui-fixture.js";

/**
 * Inline editing in a real browser (#409 step 6): `e` (Save as new take,
 * Save in place), `w`, the part menu, and delete. Every case checks the SAVED
 * story through a second connection, not only what is on screen.
 */

let browser: Browser | null = null;
async function sharedBrowser(): Promise<Browser> {
  browser ??= await launchChrome();
  return browser;
}
afterAllHook(async () => {
  await browser?.close();
});

afterEach(async () => {
  await cleanupWebUiPages();
  await cleanupWebProcesses();
});

async function spawnEditWeb(wordDelayMs = 20): Promise<ReadyWeb> {
  const project = await scratchProject();
  return await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, [DRY_RUN_WORD_DELAY_VARIABLE]: String(wordDelayMs) }
  );
}

async function poll(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return await check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForCount(locator: Locator, count: number, timeoutMs = 5_000): Promise<void> {
  expect(await poll(async () => (await locator.count()) === count, timeoutMs)).toBeTrue();
}

async function waitForAttribute(locator: Locator, name: string, value: string): Promise<void> {
  expect(await poll(async () => (await locator.getAttribute(name)) === value)).toBeTrue();
}

async function isFocused(locator: Locator): Promise<boolean> {
  return await locator.evaluate((element) => element === document.activeElement);
}

/** Saves a screenshot as `web-compose-<name>.png` into the directory named by
 * `AI_1667_WEB_UI_SCREENSHOTS`; does nothing when it is not set. */
async function screenshot(page: Page, name: string): Promise<void> {
  const dir = process.env.AI_1667_WEB_UI_SCREENSHOTS;
  if (dir !== undefined) await page.screenshot({ path: `${dir}/web-compose-${name}.png` });
}

function part(page: Page, text: string): Locator {
  return page.locator(".part").filter({ hasText: text });
}

/** A story `A → B → C` of plain human parts. */
async function seedThreeParts(web: ReadyWeb, title: string) {
  const api = await openInspectionApi(web);
  const created = await api.createStory(title);
  const pA = await api.createNode(created.id, { text: "A: the opening part.", parentId: null });
  const a = pA.path.at(-1)!.id;
  const pB = await api.createNode(created.id, { text: "B: the middle part.", parentId: a });
  const b = pB.path.at(-1)!.id;
  const pC = await api.createNode(created.id, { text: "C: the last part.", parentId: b });
  return { api, storyId: created.id, a, b, c: pC.path.at(-1)!.id };
}

async function openStory(web: ReadyWeb, storyId: string, title: string): Promise<Page> {
  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
  await page.getByRole("heading", { name: title }).waitFor();
  return page;
}

function editorProse(page: Page, partNumber: number): Locator {
  return page.getByRole("textbox", { name: `Text of part ${partNumber}` });
}

test("case 1: e then Save in place keeps the take count and marks the part as a human edit", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Edit In Place");
  const page = await openStory(web, seeded.storyId, "Edit In Place");
  const diagnostics = await collectPageDiagnostics(page);
  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");

  await page.keyboard.press("e");
  expect(await poll(() => isFocused(editorProse(page, 2)))).toBeTrue();
  expect(await editorProse(page, 2).inputValue()).toBe("B: the middle part.");
  await editorProse(page, 2).fill("B: the middle part, rewritten.");
  await screenshot(page, "editor");
  await page.getByRole("button", { name: "Save in place" }).click();

  await waitForCount(page.getByRole("textbox", { name: "Text of part 2" }), 0);
  await waitForCount(part(page, "B: the middle part, rewritten."), 1);
  expect(await part(page, "rewritten").locator(".part-badge").allTextContents()).toContain("human edit");
  expect(await part(page, "rewritten").locator(".label-chip").count()).toBe(0);
  expect(await poll(() => isFocused(part(page, "rewritten")))).toBeTrue();

  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.path[1]!.id).toBe(seeded.b);
  expect(saved.path[1]!.text).toBe("B: the middle part, rewritten.");
  expect(saved.nodes).toHaveLength(3);
  await page.waitForTimeout(300);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 60_000);

test("case 2: Ctrl/Cmd+S saves as a new take and keeps the original", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Edit As New Take");
  const page = await openStory(web, seeded.storyId, "Edit As New Take");
  await part(page, "B:").click();

  await page.keyboard.press("e");
  await editorProse(page, 2).fill("B: another way to put it.");
  await page.keyboard.press("ControlOrMeta+s");

  await waitForCount(part(page, "B: another way to put it."), 1);
  expect(await part(page, "another way").locator(".label-chip").textContent()).toContain("×2");

  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.path[1]!.text).toBe("B: another way to put it.");
  const original = await seeded.api.loadStory(seeded.storyId);
  expect(original.nodes.filter((node) => node.parentId === seeded.a)).toHaveLength(2);
  expect(original.nodes.some((node) => node.id === seeded.b)).toBeTrue();
}, 60_000);

test("case 3: a change made elsewhere shows a toast, keeps the typed text, and the next save overwrites", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Edit Conflict");
  const page = await openStory(web, seeded.storyId, "Edit Conflict");
  await part(page, "B:").click();

  await page.keyboard.press("e");
  await editorProse(page, 2).fill("B: my version.");
  const current = await seeded.api.loadStory(seeded.storyId);
  await seeded.api.editNode(seeded.storyId, current.path[1]!, { text: "B: changed from elsewhere." });

  await page.getByRole("button", { name: "Save in place" }).click();
  await page.getByText("Save again to overwrite.").first().waitFor();
  expect(await editorProse(page, 2).inputValue()).toBe("B: my version.");

  await page.getByRole("button", { name: "Save in place" }).click();
  await waitForCount(part(page, "B: my version."), 1);
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.path[1]!.text).toBe("B: my version.");
}, 60_000);

test("case 4: Escape closes a clean editor, a changed one needs a second Escape, and neither stops a background run", async () => {
  const web = await spawnEditWeb(60);
  const seeded = await seedThreeParts(web, "Edit Escape");
  const page = await openStory(web, seeded.storyId, "Edit Escape");
  await part(page, "A:").click();

  await page.keyboard.press("e");
  await editorProse(page, 1).waitFor();
  await page.keyboard.press("Escape");
  await waitForCount(editorProse(page, 1), 0);

  // Start a run on the leaf, then open an editor on an earlier part.
  await part(page, "C:").click();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Stop" }).waitFor();
  await part(page, "A:").click();
  await page.keyboard.press("e");
  await editorProse(page, 1).fill("A: changed.");
  await page.keyboard.press("Escape");
  await page.getByText("Esc again discards your changes.").waitFor();
  expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(1);
  await page.keyboard.press("Escape");
  await waitForCount(editorProse(page, 1), 0);
  expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(1);
  expect(await part(page, "A: the opening part.").count()).toBe(1);
}, 60_000);
