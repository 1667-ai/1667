import { afterEach, expect, test } from "bun:test";
import type { Browser } from "playwright-core";
import { cleanupWebProcesses, scratchProject, spawnWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  launchChrome,
  openInspectionApi,
  openTestPage
} from "./web-ui-fixture.js";

/**
 * The Library's own interactions (#409 step 4): new/rename/delete, search,
 * and the placeholder's active-path text. Cases 1–3, 10, 11 (connection,
 * fonts, theme) are `connection-shell.test.ts`, from step 3. Locators are by
 * role and accessible name — never a CSS class, which the design is free to
 * rename.
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

test("case 4: creating a story adds a row, shows the Untitled placeholder, "
  + "and survives a reload", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const page = await openTestPage(await sharedBrowser());

  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).click();
  await page.getByRole("heading", { name: "Untitled" }).waitFor();

  const hash = await page.evaluate(() => location.hash);
  expect(hash).toMatch(/^#\/story\//);

  await page.reload();
  await page.getByRole("heading", { name: "Untitled" }).waitFor();
  expect(await page.evaluate(() => location.hash)).toBe(hash);
}, 30_000);

test("case 5: renaming a story updates the row and the header, "
  + "confirmed through a second bridge connection; an empty title is refused", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Old Title");

  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => {
    location.hash = `#/story/${id}`;
  }, created.id);
  await page.getByRole("heading", { name: "Old Title" }).waitFor();

  // The row menu trigger only shows on hover (or focus-within) — the same
  // as a real pointer user would first rest over the row to find it.
  // Anchored so this never also matches the row's own "More for Old Title"
  // menu-trigger button, whose accessible name (its `title` attribute)
  // contains the same substring.
  await page.getByRole("button", { name: /^Old Title/ }).hover();
  await page.getByRole("button", { name: "More for Old Title" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename story" });
  const titleField = renameDialog.getByLabel("Title");
  await titleField.fill("");
  expect(await renameDialog.getByRole("button", { name: "Save" }).isDisabled()).toBeTrue();
  await titleField.fill("   ");
  expect(await renameDialog.getByRole("button", { name: "Save" }).isDisabled()).toBeTrue();

  await titleField.fill("New Title");
  await renameDialog.getByRole("button", { name: "Save" }).click();

  await page.getByRole("heading", { name: "New Title" }).waitFor();
  await page.getByRole("button", { name: /New Title/ }).waitFor();

  const stories = await api.listStories();
  expect(stories.find((summary) => summary.id === created.id)?.title).toBe("New Title");
}, 30_000);

test("case 6: Cancel keeps the story; Delete removes it, confirmed through a second "
  + "bridge connection, and deleting the open story returns to the Library", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Doomed");

  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => {
    location.hash = `#/story/${id}`;
  }, created.id);
  await page.getByRole("heading", { name: "Doomed" }).waitFor();

  // The row menu trigger only shows on hover (or focus-within) — the same
  // as a real pointer user would first rest over the row to find it.
  // Anchored — see the case 5 comment above.
  const row = page.getByRole("button", { name: /^Doomed/ });
  await row.hover();
  await page.getByRole("button", { name: "More for Doomed" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete story" });
  await deleteDialog.getByText("Delete Doomed? This cannot be undone.").waitFor();
  await deleteDialog.getByRole("button", { name: "Cancel" }).click();

  expect((await api.listStories()).some((summary) => summary.id === created.id)).toBeTrue();

  await row.hover();
  await page.getByRole("button", { name: "More for Doomed" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete story" })
    .getByRole("button", { name: "Delete" })
    .click();

  await expectHash(page, "#/");
  expect(await page.getByRole("button", { name: /Doomed/ }).count()).toBe(0);
  expect((await api.listStories()).some((summary) => summary.id === created.id)).toBeFalse();
}, 30_000);

test("case 7: the empty state shows once every story, including the starters, is gone", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const starters = await api.listStories();
  for (const summary of starters) await api.deleteStory(summary.id);

  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("heading", { name: "No stories yet", exact: true }).waitFor();
  await page.getByText("No stories yet — create one.").waitFor();
}, 30_000);

test("case 8: the search box narrows the list, and shows a no-match message", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  await api.createStory("Alpha Story");
  await api.createStory("Beta Story");

  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: /Alpha Story/ }).waitFor();
  await page.getByRole("button", { name: /Beta Story/ }).waitFor();

  const search = page.getByRole("searchbox", { name: "Search stories" });
  await search.fill("alpha");
  await page.getByRole("button", { name: /Alpha Story/ }).waitFor();
  expect(await page.getByRole("button", { name: /Beta Story/ }).count()).toBe(0);

  await search.fill("no such story exists");
  await page.getByText("No stories match.").waitFor();
}, 30_000);

test("case 9: the placeholder shows the active path text of a story "
  + "seeded through the bridge's createNode", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Seeded");
  await api.createNode(created.id, { text: "Once upon a time.", parentId: null });

  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => {
    location.hash = `#/story/${id}`;
  }, created.id);

  await page.getByText("Once upon a time.").waitFor();
}, 30_000);

async function expectHash(page: { evaluate<T>(fn: () => T): Promise<T> }, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate(() => location.hash) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(await page.evaluate(() => location.hash)).toBe(expected);
}
