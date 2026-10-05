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

test("settings, search and the map each download their script on first use, and work", async () => {
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

  // Reading a story needs none of the lazy views.
  for (const name of ["SettingsPage", "SearchDialog", "StoryMap", "StoryPanel", "PaletteDialog", "InspectPage"]) {
    expect(requested(scripts, name)).toBeFalse();
  }
  const firstLoad = scripts().length;
  expect(firstLoad).toBeLessThan(12);

  // Search: the key opens it, its script arrives, and it finds a word.
  await page.keyboard.press("/");
  const search = page.getByRole("dialog", { name: "Search" });
  await search.waitFor();
  expect(requested(scripts, "SearchDialog")).toBeTrue();
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

test("a chunk that fails to download shows a retry message, and the map loads after a retry or a reload", async () => {
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
  // A browser may keep the failed download for the life of the page: then the
  // message offers a reload, and the reloaded page gets the script.
  const map = page.getByRole("listbox", { name: "Story map" });
  const reload = page.getByRole("button", { name: "Reload page" });
  await Promise.race([map.waitFor(), reload.waitFor()]);
  // The map is a route: the reloaded page opens on it.
  if (await reload.isVisible()) await reload.click();
  await map.waitFor();
}, 120_000);
