import { afterEach, expect, test } from "bun:test";
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
 * The command palette (`:`), keys help (`?`) and notice log (`!`) in a real
 * browser (#409 step 10a). Locators use roles and accessible names.
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

async function spawnPaletteWeb(): Promise<ReadyWeb> {
  const project = await scratchProject();
  return await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
}

/** A story `A → B` of plain human parts, opened on its page. */
async function openSeededStory(web: ReadyWeb, title: string): Promise<{ page: Page; storyId: string }> {
  const api = await openInspectionApi(web);
  const created = await api.createStory(title);
  const first = await api.createNode(created.id, { text: "A: the opening part.", parentId: null });
  await api.createNode(created.id, { text: "B: the last part.", parentId: first.path.at(-1)!.id });
  return { page: await openStory(web, created.id, title), storyId: created.id };
}

async function openStory(web: ReadyWeb, storyId: string, title: string): Promise<Page> {
  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
  await page.getByRole("heading", { name: title }).waitFor();
  return page;
}

const palette = (page: Page): Locator => page.getByRole("dialog", { name: "Command palette" });
const directionsToggle = (page: Page): Locator => page.getByRole("button", { name: "Show directions" });

/** The text of the part that holds keyboard focus, or `null`. */
async function focusedPartText(page: Page): Promise<string | null> {
  return await page.evaluate(() => document.activeElement?.closest(".part")?.textContent ?? null);
}

test("case 1: : then 'directions' lists toggle directions first; Enter toggles and the part keeps focus", async () => {
  const web = await spawnPaletteWeb();
  const { page } = await openSeededStory(web, "Palette Directions");
  await page.locator(".part").filter({ hasText: "B:" }).click();
  expect(await poll(async () => (await focusedPartText(page))?.includes("B:") === true)).toBeTrue();
  expect(await directionsToggle(page).getAttribute("aria-pressed")).toBe("false");

  await page.keyboard.press(":");
  await palette(page).waitFor();
  await page.keyboard.type("directions");
  const first = palette(page).getByRole("option").first();
  expect(await first.textContent()).toContain("toggle directions");
  expect(await first.getAttribute("aria-selected")).toBe("true");
  await screenshot(page, "10a-palette");
  await page.keyboard.press("Enter");

  await palette(page).waitFor({ state: "detached" });
  expect(await poll(async () => (await directionsToggle(page).getAttribute("aria-pressed")) === "true")).toBeTrue();
  expect((await focusedPartText(page))?.includes("B:")).toBeTrue();
});

test("case 2: : inside the composer types a colon; Esc on the palette changes nothing", async () => {
  const web = await spawnPaletteWeb();
  const { page } = await openSeededStory(web, "Palette Composer");
  const composer = page.getByRole("textbox", { name: "What happens next?" });
  await composer.click();
  await page.keyboard.press(":");
  expect(await composer.inputValue()).toBe(":");
  expect(await palette(page).count()).toBe(0);
  await page.keyboard.press("Escape");
  expect(await poll(async () => (await focusedPartText(page)) !== null)).toBeTrue();

  await page.keyboard.press(":");
  await palette(page).waitFor();
  await page.keyboard.press("Escape");
  await palette(page).waitFor({ state: "detached" });
  expect(await directionsToggle(page).getAttribute("aria-pressed")).toBe("false");
  expect(await poll(async () => (await focusedPartText(page)) !== null)).toBeTrue();
  expect(await composer.inputValue()).toBe(":");
});

test("case 3: ? lists Continue with Space, and no ⌃U, ⌃D or ⌃P; Esc closes it", async () => {
  const web = await spawnPaletteWeb();
  const { page } = await openSeededStory(web, "Palette Keys");
  await page.locator(".part").first().click();
  await page.keyboard.press("?");
  const keys = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await keys.waitFor();
  const row = keys.locator(".keys-row").filter({ hasText: "continue this part" });
  expect(await row.locator("dt").textContent()).toBe("space");
  const text = ((await keys.textContent()) ?? "").toLowerCase();
  for (const chord of ["⌃u", "⌃d", "⌃p", "ctrl+u", "ctrl+d", "ctrl+p"]) expect(text).not.toContain(chord);
  expect(text).not.toContain("quit");
  await screenshot(page, "10a-keys");
  await page.keyboard.press("Escape");
  await keys.waitFor({ state: "detached" });
});

test("case 4: a refusal toast is later in ! with a time", async () => {
  const web = await spawnPaletteWeb();
  const api = await openInspectionApi(web);
  const created = await api.createStory("Palette Log");
  const page = await openStory(web, created.id, "Palette Log");

  await page.keyboard.press("m");
  const toast = page.locator(".toast").filter({ hasText: "Nothing to map yet." });
  await toast.waitFor();
  await toast.getByRole("button", { name: "Dismiss" }).click();
  await toast.waitFor({ state: "detached" });

  await page.keyboard.press("!");
  const log = page.getByRole("dialog", { name: "Notice log" });
  await log.waitFor();
  const row = log.getByRole("listitem").filter({ hasText: "Nothing to map yet." });
  expect(await row.count()).toBe(1);
  expect(await row.locator("time").textContent()).toMatch(/\d{1,2}:\d{2}/);
  await screenshot(page, "10a-log");
  await page.keyboard.press("Escape");
  await log.waitFor({ state: "detached" });
});

test("case 5: ! on the map route opens the log; Esc goes back to the map", async () => {
  const web = await spawnPaletteWeb();
  const { page, storyId } = await openSeededStory(web, "Palette Map");
  await page.locator(".part").first().waitFor();
  await page.keyboard.press("m");
  await page.getByRole("heading", { name: "Map" }).waitFor();

  await page.keyboard.press("!");
  const log = page.getByRole("dialog", { name: "Notice log" });
  await log.waitFor();
  await page.keyboard.press("Escape");
  await log.waitFor({ state: "detached" });
  expect(await page.evaluate(() => location.hash)).toBe(`#/story/${storyId}/map`);
  await page.getByRole("heading", { name: "Map" }).waitFor();
});
