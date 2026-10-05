import { afterEach, expect, test } from "bun:test";
import type { Browser, Page } from "playwright-core";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
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
 * Route-level code splitting (#409 step 10m): the first load holds only the
 * reading and writing code, and the settings page, the search and the map
 * each download their script when a writer first opens them. The test counts
 * the script requests of the page.
 */

let browser: Browser | null = null;
afterAllHook(async () => {
  await browser?.close();
});

afterEach(async () => {
  await cleanupWebUiPages();
  await cleanupWebProcesses();
});

/** The names of the scripts the page has requested so far. */
function trackScripts(page: Page): () => string[] {
  const scripts: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/assets/") && path.endsWith(".js")) scripts.push(path.slice("/assets/".length));
  });
  return () => [...scripts];
}

const requested = (scripts: () => string[], name: string): boolean =>
  scripts().some((script) => script.startsWith(`${name}-`));

test("settings and the map each download their script on first use, and search works from the first load, and work", async () => {
  browser ??= await launchChrome();
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(browser);
  const scripts = trackScripts(page);
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await page.locator(".part").first().click();

  // Reading a story needs none of these views. (The palette, the panel and the
  // editor download when the page is idle, so a key finds them ready.)
  for (const name of ["SettingsPage", "StoryMap", "InspectPage"]) {
    expect(requested(scripts, name)).toBeFalse();
  }

  // Search is part of the first load: the key opens it at once, and it finds a word.
  await page.keyboard.press("/");
  const search = page.getByRole("dialog", { name: "Search" });
  await search.waitFor();
  await page.keyboard.type("second take");
  await search.getByRole("option").filter({ hasText: "B2:" }).waitFor();
  await page.keyboard.press("Escape");
  await search.waitFor({ state: "detached" });
  expect(requested(scripts, "StoryMap")).toBeFalse();
  expect(requested(scripts, "SettingsPage")).toBeFalse();

  // The map: the key opens it, its script arrives, and it lists the parts.
  await page.locator(".part").first().click();
  await page.keyboard.press("m");
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  expect(requested(scripts, "StoryMap")).toBeTrue();
  expect(await page.getByRole("option").count()).toBeGreaterThan(0);
  expect(requested(scripts, "SettingsPage")).toBeFalse();

  // Settings: the button opens the page, and its script arrives.
  await page.getByRole("button", { name: /^Settings \(,\)/ }).click();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  expect(requested(scripts, "SettingsPage")).toBeTrue();
  expect(await page.getByRole("button", { name: /^Provider/ }).count()).toBeGreaterThan(0);

  // Each script was requested once: a second visit does not download it again.
  const before = scripts().length;
  await page.getByRole("button", { name: /^Forked Story/ }).click();
  await page.getByRole("heading", { name: "Forked Story", level: 1 }).waitFor();
  await page.getByRole("button", { name: /^Settings \(,\)/ }).click();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  expect(scripts().length).toBe(before);
}, 120_000);

test("a chunk that fails to download shows a retry message, and Retry loads it without a reload", async () => {
  browser ??= await launchChrome();
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(browser);
  let failures = 1;
  await page.route(/\/assets\/StoryMap-[^/]+\.js$/, async (route) => {
    if (failures > 0) {
      failures -= 1;
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, seeded.storyId);
  await page.locator(".part").first().click();
  await page.keyboard.press("m");
  const alert = page.getByRole("alert");
  await alert.waitFor();
  expect(await alert.textContent()).toContain("did not load");
  await alert.getByRole("button", { name: "Retry" }).click();
  // Retry downloads the script again and shows the map without a page reload.
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  expect(await alert.count()).toBe(0);
}, 120_000);

test("keys typed while a view downloads are not lost, and do not act on the story", async () => {
  browser ??= await launchChrome();
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(browser);
  // Every lazy chunk is slow, as on a cold cache over a slow link.
  await page.route(/\/assets\/[^/]+\.js$/, async (route) => {
    if (!/\/assets\/index-/.test(route.request().url())) await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await page.locator(".part").first().click();

  // The palette takes the typed text at once, however slow the other chunks are.
  await page.keyboard.press(":");
  await page.keyboard.type("settings");
  expect(await page.getByLabel("Command", { exact: true }).inputValue()).toBe("settings");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });

  // A view that is still downloading holds the keys back: `n` must not open the note.
  await page.keyboard.press("!");
  await page.keyboard.type("nnn");
  expect(await page.getByRole("dialog", { name: "Note" }).count()).toBe(0);
  await page.getByRole("dialog", { name: "Notice log" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Notice log" }).waitFor({ state: "detached" });
}, 120_000);

const slowChunks = async (page: Page): Promise<void> => {
  await page.route(/\/assets\/[^/]+\.js$/, async (route) => {
    if (!/\/assets\/index-/.test(route.request().url())) await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
};

test("Esc still works while the map downloads during a running Continue", async () => {
  browser ??= await launchChrome();
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], { ...project.env, [DRY_RUN_WORD_DELAY_VARIABLE]: "200" });
  const api = await openInspectionApi(web);
  const created = await api.createStory("Esc Story");
  await api.createNode(created.id, { text: "Start.", parentId: null });

  const page = await openTestPage(browser);
  await slowChunks(page);
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, created.id);
  await page.getByRole("heading", { name: "Esc Story" }).waitFor();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Stop" }).waitFor();
  await page.locator(".part").first().click();
  await page.keyboard.press("m");
  await page.keyboard.press("Escape");
  // During the download Esc closes the map route or stops the run; it is never dead.
  await page.waitForFunction(() => !location.hash.endsWith("/map")
    || ![...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Stop"));
}, 120_000);

test("a remembered Facts dock does not block story keys on a cold load", async () => {
  browser ??= await launchChrome();
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(browser, { viewport: { width: 1400, height: 900 } });
  await page.addInitScript(() => { localStorage.setItem("1667.web.factsDocked", "1"); });
  await slowChunks(page);
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await page.locator(".part").first().click();
  await page.keyboard.press("ArrowDown");
  // Focus moved to the next part while the docked panel was still downloading.
  expect(await page.evaluate(() => document.activeElement?.closest(".part")?.textContent ?? "")).toContain("B");
}, 120_000);
