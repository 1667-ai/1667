import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { Browser, Locator, Page } from "playwright-core";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  launchChrome,
  openInspectionApi,
  openTestPage
} from "./web-ui-fixture.js";

/**
 * The small story keys and commands in a real browser (#409 step 10b): `y` and
 * `Y` copy, `z` typewriter mode, `n` Author's Note, and the palette's autoname
 * story and export markdown. Locators use roles and accessible names.
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

async function poll(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return await check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Saves a screenshot as `web-<name>.png` into the directory named by
 * `AI_1667_WEB_UI_SCREENSHOTS`; does nothing when it is not set. */
async function screenshot(page: Page, name: string): Promise<void> {
  const dir = process.env.AI_1667_WEB_UI_SCREENSHOTS;
  if (dir === undefined) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/web-${name}.png` });
}

async function spawnKeysWeb(): Promise<ReadyWeb> {
  const project = await scratchProject();
  return await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
}

/** A story of plain human parts, one per text, opened on its page. */
async function openSeededStory(
  web: ReadyWeb,
  title: string,
  texts: readonly string[]
): Promise<{ page: Page; storyId: string }> {
  const api = await openInspectionApi(web);
  const created = await api.createStory(title);
  let parentId: string | null = null;
  for (const text of texts) {
    const payload = await api.createNode(created.id, { text, parentId });
    parentId = payload.path.at(-1)!.id;
  }
  const page = await openTestPage(await sharedBrowser(), { permissions: ["clipboard-read", "clipboard-write"] });
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, created.id);
  await page.getByRole("heading", { name: title }).waitFor();
  return { page, storyId: created.id };
}

const part = (page: Page, text: string): Locator => page.locator(".part").filter({ hasText: text });
const palette = (page: Page): Locator => page.getByRole("dialog", { name: "Command palette" });

async function clipboardText(page: Page): Promise<string> {
  return await page.evaluate(() => navigator.clipboard.readText());
}

async function runCommand(page: Page, query: string): Promise<void> {
  await page.keyboard.press(":");
  await palette(page).waitFor();
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
  await palette(page).waitFor({ state: "detached" });
}

test("case 1: y copies the focused part, Y the whole line, and the part menu has Copy", async () => {
  const web = await spawnKeysWeb();
  const { page } = await openSeededStory(web, "Copy Keys", [
    "One: the opening part.",
    "Two: the middle part.",
    "Three: the last part."
  ]);
  await part(page, "Two:").click();
  await page.keyboard.press("y");
  expect(await poll(async () => (await clipboardText(page)) === "Two: the middle part.")).toBeTrue();
  expect(await page.getByText(/Copied ¶ 2/).count()).toBeGreaterThan(0);

  await page.keyboard.press("Shift+Y");
  expect(await poll(async () => (await clipboardText(page))
    === "One: the opening part.\n\nTwo: the middle part.\n\nThree: the last part.")).toBeTrue();

  await part(page, "One:").click();
  await page.keyboard.press("x");
  await page.getByRole("menuitem", { name: "Copy" }).click();
  expect(await poll(async () => (await clipboardText(page)) === "One: the opening part.")).toBeTrue();
});

test("case 2: z keeps the focused part centered while moving, and it is remembered after a reload", async () => {
  const web = await spawnKeysWeb();
  const texts = Array.from({ length: 14 }, (_, index) =>
    `Part ${index + 1}: ${"the story goes on and on across the page. ".repeat(6)}`);
  const { page } = await openSeededStory(web, "Typewriter Keys", texts);
  const centerOffset = async (): Promise<number> => await page.evaluate(() => {
    const current = document.querySelector<HTMLElement>('.story-scroll [data-part-id][aria-current="true"]');
    const scroll = document.querySelector<HTMLElement>(".story-scroll");
    if (current === null || scroll === null) return Number.POSITIVE_INFINITY;
    const part = current.getBoundingClientRect();
    const view = scroll.getBoundingClientRect();
    return Math.abs((part.top + part.bottom) / 2 - (view.top + view.bottom) / 2);
  });
  const on = page.locator(".story-scroll-typewriter");

  await part(page, "Part 5:").click();
  await page.keyboard.press("z");
  await on.waitFor();
  expect(await poll(async () => (await centerOffset()) < 24)).toBeTrue();
  await page.keyboard.press("ArrowDown");
  expect(await poll(async () => (await part(page, "Part 6:").getAttribute("aria-current")) === "true")).toBeTrue();
  expect(await poll(async () => (await centerOffset()) < 24)).toBeTrue();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  expect(await poll(async () => (await part(page, "Part 4:").getAttribute("aria-current")) === "true")).toBeTrue();
  expect(await poll(async () => (await centerOffset()) < 24)).toBeTrue();
  await screenshot(page, "10b-typewriter");

  await page.reload();
  await page.getByRole("heading", { name: "Typewriter Keys" }).waitFor();
  await on.waitFor();
  expect(await poll(async () => (await centerOffset()) < 24)).toBeTrue();
});

test("case 3: n saves an Author's Note with a depth, and reopening shows both", async () => {
  const web = await spawnKeysWeb();
  const { page, storyId } = await openSeededStory(web, "Note Keys", ["First part.", "Second part.", "Third part."]);
  const api = await openInspectionApi(web);
  await part(page, "Second").click();
  await page.keyboard.press("n");
  const dialog = page.getByRole("dialog", { name: "Author's Note" });
  await dialog.waitFor();
  await dialog.getByRole("textbox").fill("Keep it quiet and cold.");
  await dialog.getByRole("button", { name: "Deeper" }).click();
  await dialog.getByRole("button", { name: "Deeper" }).click();
  expect(await dialog.getByLabel("Depth value").textContent()).toBe("3");
  await screenshot(page, "10b-authors-note");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });

  const stored = await api.loadStory(storyId);
  expect(stored.authorsNote).toBe("Keep it quiet and cold.");
  expect(stored.authorsNoteDepth).toBe(3);

  await page.keyboard.press("n");
  await dialog.waitFor();
  expect(await dialog.getByRole("textbox").inputValue()).toBe("Keep it quiet and cold.");
  expect(await dialog.getByLabel("Depth value").textContent()).toBe("3");
});

test("case 4: the palette's autoname story changes the header and the sidebar", async () => {
  const web = await spawnKeysWeb();
  const { page, storyId } = await openSeededStory(web, "Plain Working Title", [
    "The lighthouse keeper counted the ships that never came.",
    "Each night the lamp burned a little lower."
  ]);
  const api = await openInspectionApi(web);
  await runCommand(page, "autoname");
  expect(await poll(async () => (await api.loadStory(storyId)).title !== "Plain Working Title", 15_000)).toBeTrue();
  const title = (await api.loadStory(storyId)).title;
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  const sidebar = page.getByRole("complementary");
  await sidebar.getByText(title, { exact: true }).waitFor();
  expect(await sidebar.getByText("Plain Working Title").count()).toBe(0);
});

test("case 5: the palette's export markdown downloads <title>.md with the story's Markdown", async () => {
  const web = await spawnKeysWeb();
  const { page, storyId } = await openSeededStory(web, "Export: Keys", ["Exported part one.", "Exported part two."]);
  const api = await openInspectionApi(web);
  const downloading = page.waitForEvent("download");
  await runCommand(page, "export markdown");
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("Export- Keys.md");
  const path = await download.path();
  expect(await readFile(path, "utf8")).toBe((await api.exportMarkdown(storyId)).markdown);
});

test("case 6: a stale note draft does not overwrite newer text unseen; the second Save does", async () => {
  const web = await spawnKeysWeb();
  const { page, storyId } = await openSeededStory(web, "Stale Note", ["First part.", "Second part."]);
  const api = await openInspectionApi(web);
  const dialog = page.getByRole("dialog", { name: "Author's Note" });
  await part(page, "Second").click();
  await page.keyboard.press("n");
  await dialog.getByRole("textbox").fill("My draft.");
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "detached" });

  await api.setAuthorsNote(storyId, "Text from another window.", 1);
  await page.evaluate(() => { location.hash = "#/"; });
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
  await page.getByRole("heading", { name: "Stale Note" }).waitFor();
  await part(page, "Second").click();
  await page.keyboard.press("n");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.getByText(/changed in another window/).first().waitFor();
  expect((await api.loadStory(storyId)).authorsNote).toBe("Text from another window.");

  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  expect((await api.loadStory(storyId)).authorsNote).toBe("My draft.");
});
