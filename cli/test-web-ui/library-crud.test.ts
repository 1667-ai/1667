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
  // The list refresh after the delete lands after the navigation; wait for it.
  await page.getByRole("button", { name: /Doomed/ }).waitFor({ state: "detached" });
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
  await page.getByRole("button", { name: /Beta Story/ }).waitFor({ state: "detached" });

  await search.fill("no such story exists");
  await page.getByText("No stories match.").waitFor();
}, 30_000);

test("the / key focuses search (section 5's one keybinding beyond native)", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const page = await openTestPage(await sharedBrowser());

  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.keyboard.press("/");
  const focused = await page.getByRole("searchbox", { name: "Search stories" })
    .evaluate((element) => element === document.activeElement);
  expect(focused).toBeTrue();
}, 30_000);

test("opening a story that no longer exists shows a 'no longer exists' state "
  + "with a link back to the Library (review fix B3)", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Vanishing");
  await api.deleteStory(created.id);

  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => {
    location.hash = `#/story/${id}`;
  }, created.id);

  await page.getByRole("heading", { name: "This story no longer exists" }).waitFor();
  await page.getByRole("link", { name: "Back to the Library" }).click();
  await expectHash(page, "#/");
  await page.getByRole("button", { name: "New story" }).waitFor();
}, 30_000);

test("deleting the open story while navigating to another story lands on the "
  + "other story, not the Library (review fix B4)", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const storyA = await api.createStory("Story A");
  const storyB = await api.createStory("Story B");

  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.evaluate((id) => {
    location.hash = `#/story/${id}`;
  }, storyA.id);
  await page.getByRole("heading", { name: "Story A" }).waitFor();

  // Anchored — see the case 5 comment above.
  await page.getByRole("button", { name: /^Story A/ }).hover();
  await page.getByRole("button", { name: "More for Story A" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete story" })
    .getByRole("button", { name: "Delete" })
    .click();
  // Deliberately do not wait for the delete to resolve: navigate to a
  // different story right away, the way a fast double-click would. The old
  // code captured "was this the open story" from the route BEFORE the
  // `deleteStory` await, so it would navigate home out from under this
  // already-different route once the delete finally resolved.
  await page.evaluate((id) => {
    location.hash = `#/story/${id}`;
  }, storyB.id);

  await page.getByRole("heading", { name: "Story B" }).waitFor();
  // The test did not wait for the delete, so it may still be running; wait
  // (bounded) for it to land before checking where the page ended up.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!(await api.listStories()).some((summary) => summary.id === storyA.id)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect((await api.listStories()).some((summary) => summary.id === storyA.id)).toBeFalse();
  expect(await page.evaluate(() => location.hash)).toBe(`#/story/${storyB.id}`);
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
