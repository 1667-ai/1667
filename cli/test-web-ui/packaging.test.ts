import { afterEach, expect, test } from "bun:test";
import type { Browser } from "playwright-core";
import { cleanupWebProcesses, scratchProject, spawnWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  collectPageDiagnostics,
  launchChrome,
  openInspectionApi,
  openTestPage
} from "./web-ui-fixture.js";

/** A story route and its map route load with a clean console. */

let browser: Browser | null = null;
afterAllHook(async () => {
  await browser?.close();
});

afterEach(async () => {
  await cleanupWebUiPages();
  await cleanupWebProcesses();
});

test("a story route and the map route open with a clean console", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const story = await api.createStory("Packaged Story");
  await api.createNode(story.id, { text: "The packaged story opens.", parentId: null });

  browser ??= await launchChrome();
  const page = await openTestPage(browser);
  const diagnostics = await collectPageDiagnostics(page);
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, story.id);
  await page.getByRole("heading", { name: "Packaged Story" }).waitFor();
  await page.locator("p", { hasText: "The packaged story opens." }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}/map`; }, story.id);
  await page.getByRole("listbox", { name: "Story map" }).waitFor();

  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 60_000);
