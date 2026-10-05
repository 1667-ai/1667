import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  launchChrome,
  openInspectionApi,
  openTestPage
} from "./web-ui-fixture.js";

/**
 * Defects found by release-testing the web UI (#409): the part menu stays on
 * screen, the mouse and a triple click keep a selection for it, a stopped
 * save shows no image toast without an image, and the story keys work again
 * after the map closes over a docked panel.
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

async function poll(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return await check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const FIRST_PARAGRAPH = "Alpha one walks the long road to the harbor.";
const SECOND_PARAGRAPH = "Alpha two lights the lamp above the quiet water.";

async function openStory(
  partTexts: readonly string[],
  viewport: { width: number; height: number },
  env: Record<string, string> = {}
): Promise<{ readonly web: ReadyWeb; readonly page: Page }> {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], { ...project.env, ...env });
  const api = await openInspectionApi(web);
  const created = await api.createStory("Release Story");
  let parentId: string | null = null;
  for (const text of partTexts) {
    const made = await api.createNode(created.id, { text, parentId });
    parentId = made.path.at(-1)!.id;
  }
  const page = await openTestPage(await sharedBrowser(), { viewport });
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, created.id);
  await page.getByRole("heading", { name: "Release Story" }).waitFor();
  await page.locator(".part").first().waitFor();
  return { web, page };
}

function part(page: Page, text: string): Locator {
  return page.locator(".part").filter({ hasText: text });
}

const LONG_PART = Array.from({ length: 3 }, (_, index) => `Paragraph ${index + 1} of a long part. `.repeat(12).trim()).join("\n\n");

async function expectMenuOnScreen(page: Page, partIndex: number): Promise<void> {
  await page.locator(".part").nth(partIndex).getByRole("button", { name: "Part actions (x)" }).click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  const box = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height <= viewport.height).toBeTrue();
  // Every item can be reached: the last one scrolls into the menu's own box.
  const items = menu.getByRole("menuitem");
  const last = items.last();
  await last.scrollIntoViewIfNeeded();
  const lastBox = (await last.boundingBox())!;
  const after = (await menu.boundingBox())!;
  expect(lastBox.y + lastBox.height <= after.y + after.height + 1).toBeTrue();
  expect(lastBox.y).toBeGreaterThanOrEqual(after.y - 1);
  await items.first().scrollIntoViewIfNeeded();
  const firstBox = (await items.first().boundingBox())!;
  expect(firstBox.y).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
}

test("case 1: the part menu stays inside the screen at the bottom and at the top", async () => {
  const parts = Array.from({ length: 8 }, (_, index) => `Part ${index + 1}. ${LONG_PART}`);
  const { page } = await openStory(parts, { width: 1280, height: 600 });
  const scroll = page.locator(".story-scroll");
  await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expectMenuOnScreen(page, 7);
  await scroll.evaluate((element) => { element.scrollTop = 0; });
  await expectMenuOnScreen(page, 0);
  await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight / 2; });
  const middle = await page.locator(".part").evaluateAll((elements) => elements.findIndex((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top > 250 && rect.top < 350;
  }));
  if (middle >= 0) await expectMenuOnScreen(page, middle);
}, 90_000);

test("case 2: a mouse click on the menu button keeps the text selection", async () => {
  const { page } = await openStory([`${FIRST_PARAGRAPH}\n\n${SECOND_PARAGRAPH}`], { width: 1400, height: 900 });
  const rect = await page.locator(".part .prose p").first().evaluate((paragraph) => {
    const node = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 20);
    const box = range.getBoundingClientRect();
    return { left: box.left, right: box.right, y: box.top + box.height / 2 };
  });
  await page.mouse.move(rect.left + 1, rect.y);
  await page.mouse.down();
  await page.mouse.move(rect.right - 1, rect.y, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()!.toString().length)).toBeGreaterThan(3);
  await page.locator(".part").first().getByRole("button", { name: "Part actions (x)" }).click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "Rewrite selection" }).waitFor();
  await menu.getByRole("menuitem", { name: "Copy selection" }).waitFor();
}, 60_000);

test("case 3: a triple-clicked paragraph counts as the selection", async () => {
  const { page } = await openStory(
    [`${FIRST_PARAGRAPH}\n\n${SECOND_PARAGRAPH}`, "Beta part. Nothing here is selected."],
    { width: 1400, height: 900 }
  );
  await page.locator(".part .prose p").nth(1).click({ clickCount: 3 });
  await page.keyboard.press("x");
  const menu = page.getByRole("menu");
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "Rewrite selection" }).click();
  await page.getByRole("textbox", { name: "Instruction for the rewrite" }).waitFor();
  const target = (await page.locator(".composer-target").textContent())!;
  // The box names the target, cut to a short preview.
  expect(target).toContain(`“${SECOND_PARAGRAPH.slice(0, 30)}`);
  expect(target).not.toContain("Beta part");
  expect(target).not.toContain("Alpha one");
}, 60_000);

test("case 4: a stopped save without an image shows no image toast", async () => {
  const { page } = await openStory(["The lamp burns low."], { width: 1400, height: 900 }, { [DRY_RUN_WORD_DELAY_VARIABLE]: "250" });
  await page.locator(".part").first().click();
  await page.keyboard.press("i");
  const field = page.getByRole("textbox", { name: "What happens next?" });
  await field.fill("The wind rises");
  await field.press("Enter");
  await page.getByRole("button", { name: "Stop" }).waitFor();
  await page.waitForTimeout(6_000);
  await page.keyboard.press("Escape");
  await page.getByText(/Stopped\. Part 2 kept/).first().waitFor({ state: "attached" }).catch(() => undefined);
  expect(await poll(async () => (await page.getByRole("button", { name: "Stop" }).count()) === 0)).toBeTrue();
  expect(await poll(async () => (await page.locator(".part").count()) === 2)).toBeTrue();
  expect(await page.getByText("saved without its images").count()).toBe(0);
  await page.keyboard.press("!");
  await page.waitForTimeout(300);
  expect(await page.getByText("saved without its images").count()).toBe(0);
}, 60_000);

test("case 5: the story keys work after Esc closes the map over a docked panel", async () => {
  const { page } = await openStory(["Part one text.", "Part two text.", "Part three text."], { width: 1400, height: 900 });
  await page.locator(".part").first().click();
  await page.keyboard.press("c");
  const panel = page.getByRole("complementary", { name: "Chapters" });
  await panel.waitFor();
  await page.locator(".part").first().click();
  await page.keyboard.press("m");
  await page.getByRole("button", { name: "Close map (Esc)" }).waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".story-scroll").waitFor();
  await page.waitForTimeout(500);
  await page.keyboard.press("ArrowDown");
  expect(await poll(async () => (await page.locator(".part").nth(1).getAttribute("aria-current")) === "true")).toBeTrue();
}, 60_000);
