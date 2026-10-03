import { afterEach, expect, test } from "bun:test";
import type { Browser, Page } from "playwright-core";
import { cleanupWebProcesses, scratchProject, spawnWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  launchChrome,
  openInspectionApi,
  openTestPage,
  seedForkedStory
} from "./web-ui-fixture.js";

/**
 * The browser's Back and Forward buttons move between the pages of the app
 * (Library, a story, its map) like on any web site. They stay inside the one
 * loaded page: the app never reloads, so nothing typed is lost.
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

async function waitForHash(page: Page, expected: RegExp): Promise<void> {
  await page.waitForFunction((source) => new RegExp(source).test(location.hash), expected.source);
}

/** Marks the loaded document, so a test can prove Back never reloaded it. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { documentMark?: string }).documentMark = "still here";
  });
}

async function documentKept(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { documentMark?: string }).documentMark === "still here");
}

test("case 1: Back and Forward move between Library, stories, and the map without leaving the app", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const forked = await seedForkedStory(api);
  const other = await api.createStory("Second Story");
  await api.createNode(other.id, { text: "S1: the only part.", parentId: null });

  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await markDocument(page);

  await page.getByRole("button", { name: /^Forked Story/ }).click();
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await page.getByRole("button", { name: /^Second Story/ }).click();
  await page.getByRole("heading", { name: "Second Story" }).waitFor();
  await page.getByRole("button", { name: /^Forked Story/ }).click();
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await page.getByRole("button", { name: "Map (m)" }).click();
  await page.getByRole("listbox", { name: "Story map" }).waitFor();

  await page.goBack();
  await waitForHash(page, new RegExp(`^#/story/${forked.storyId}$`));
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await page.goBack();
  await waitForHash(page, new RegExp(`^#/story/${other.id}$`));
  await page.getByRole("heading", { name: "Second Story" }).waitFor();
  await page.goBack();
  await waitForHash(page, new RegExp(`^#/story/${forked.storyId}$`));
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await page.goBack();
  await waitForHash(page, /^(#\/?)?$/);
  await page.getByRole("button", { name: "New story" }).waitFor();
  expect(await page.getByRole("heading", { name: "Forked Story" }).count()).toBe(0);

  await page.goForward();
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await page.goForward();
  await page.getByRole("heading", { name: "Second Story" }).waitFor();

  // `o` opens the Library as a page of its own: Back returns to the story.
  await page.locator(".part").first().click();
  await page.keyboard.press("o");
  await waitForHash(page, /^#\/$/);
  await page.goBack();
  await page.getByRole("heading", { name: "Second Story" }).waitFor();

  expect(await documentKept(page)).toBeTrue();
}, 60_000);

test("case 2: after the open story is deleted, Back does not return to it", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const kept = await api.createStory("Kept Story");
  await api.createNode(kept.id, { text: "K1: a part that stays.", parentId: null });
  await api.createStory("Doomed");

  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await markDocument(page);
  await page.getByRole("button", { name: /^Kept Story/ }).click();
  await page.getByRole("heading", { name: "Kept Story" }).waitFor();
  await page.getByRole("button", { name: /^Doomed/ }).click();
  await page.getByRole("heading", { name: "Doomed" }).waitFor();

  const row = page.getByRole("button", { name: /^Doomed/ });
  await row.hover();
  await page.getByRole("button", { name: "Story actions for Doomed" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete story" }).getByRole("button", { name: "Delete" }).click();
  await waitForHash(page, /^#\/$/);
  await row.waitFor({ state: "detached" });

  await page.goBack();
  await page.getByRole("heading", { name: "Kept Story" }).waitFor();
  expect(await documentKept(page)).toBeTrue();
}, 60_000);
