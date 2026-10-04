import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
import { EDITOR_OPEN_TOAST, STORY_LOCKED_TOAST } from "../../web/src/story/part-policy.js";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  launchChrome,
  openInspectionApi,
  openTestPage,
  seedForkedStory
} from "./web-ui-fixture.js";
import { screenshot, seedLargeStory } from "./map-fixture.js";

/**
 * The story map (#409 step 8) in a real browser: its own page at
 * `#/story/<id>/map`, the tree and path views, and switching lines. Locators
 * use roles and accessible names. Every case that switches a line checks the
 * SAVED story through a second connection, not only what is on screen.
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

async function openStoryPage(page: Page, web: ReadyWeb, storyId: string): Promise<void> {
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
}

async function poll(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return await check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForCount(locator: Locator, count: number): Promise<void> {
  expect(await poll(async () => (await locator.count()) === count)).toBeTrue();
}

async function waitForHash(page: Page, pattern: RegExp): Promise<void> {
  expect(await poll(async () => pattern.test(await page.evaluate(() => location.hash)))).toBeTrue();
}

function options(page: Page): Locator {
  return page.getByRole("option");
}

/** The option the cursor is on. */
function selected(page: Page): Locator {
  return page.locator('[role="option"][aria-selected="true"]');
}

async function waitForSelected(page: Page, text: string | RegExp): Promise<void> {
  const ok = await poll(async () => {
    const found = await selected(page).first().textContent({ timeout: 500 }).catch(() => null);
    return found !== null && (typeof text === "string" ? found.includes(text) : text.test(found));
  });
  expect(ok).toBeTrue();
}

/** The map opens in the path view; most cases here are about the tree. */
async function showTree(page: Page): Promise<void> {
  const tree = page.getByRole("button", { name: "Tree", exact: true });
  if ((await tree.getAttribute("aria-pressed")) !== "true") await tree.click();
  expect(await poll(async () => (await tree.getAttribute("aria-pressed")) === "true")).toBeTrue();
}

async function openMapWithKey(page: Page, view: "tree" | "path" = "tree"): Promise<void> {
  await page.getByRole("button", { name: "Map (m)" }).waitFor();
  await page.locator(".part").first().waitFor();
  await page.keyboard.press("m");
  await waitForHash(page, /\/map$/);
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  if (view === "tree") await showTree(page);
}

async function savedLeaf(api: Awaited<ReturnType<typeof openInspectionApi>>, storyId: string): Promise<string> {
  const payload = await api.loadStory(storyId);
  return payload.path.map((node) => node.id).join(",");
}

test("case 1: m and the Map button open the map as its own page, the cursor "
  + "starts on the focused part, Esc and Back return with focus on it", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  await openMapWithKey(page, "path");
  // The map opens in the path view.
  expect(await page.getByRole("button", { name: "Path", exact: true }).getAttribute("aria-pressed")).toBe("true");
  await showTree(page);
  expect(await page.locator(".part").count()).toBe(0);
  await page.getByRole("heading", { name: "Map" }).waitFor();
  expect((await options(page).count()) >= 4).toBeTrue();
  await waitForSelected(page, "C1:");
  await screenshot(page, "tree");

  await page.keyboard.press("Escape");
  await waitForHash(page, new RegExp(`/story/${seeded.storyId}$`));
  await page.locator(".part").first().waitFor();
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-part-id") !== null)).toBeTrue();
  expect(await page.evaluate(() => document.activeElement?.textContent?.includes("C1:"))).toBeTrue();

  await page.getByRole("button", { name: "Map (m)" }).click();
  await waitForHash(page, /\/map$/);
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  await showTree(page);
  await page.goBack();
  await waitForHash(page, new RegExp(`/story/${seeded.storyId}$`));
  await page.locator(".part").first().waitFor();
  expect(await page.evaluate(() => document.activeElement?.textContent?.includes("C1:"))).toBeTrue();
}, 60_000);

test("case 2: ↑↓ walk the rows and ←→ cross to the next lane in the tree view", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const seeded = await seedForkedStory(await openInspectionApi(web));
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page);
  await waitForSelected(page, "C1:");

  await page.keyboard.press("ArrowUp");
  await waitForSelected(page, "B1:");
  await page.keyboard.press("ArrowUp");
  await waitForSelected(page, "A1:");
  await page.keyboard.press("ArrowUp");
  await waitForSelected(page, "A1:");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await waitForSelected(page, "C1:");
  await page.keyboard.press("ArrowDown");
  await waitForSelected(page, "C2:");
  await page.keyboard.press("ArrowLeft");
  await waitForSelected(page, "C1:");
  await page.keyboard.press("ArrowRight");
  await waitForSelected(page, "C2:");
  // The cursor is the listbox's active descendant: DOM focus never leaves it.
  const active = await page.getByRole("listbox", { name: "Story map" }).getAttribute("aria-activedescendant");
  expect(await page.locator(`[id="${active}"]`).getAttribute("aria-selected")).toBe("true");
}, 60_000);

test("case 3: Enter on another line's end switches the line, and it survives a reload", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page);
  await page.keyboard.press("ArrowRight");
  await waitForSelected(page, "C2:");
  await page.keyboard.press("Enter");

  await waitForHash(page, new RegExp(`/story/${seeded.storyId}$`));
  await page.locator(".part").filter({ hasText: "C2:" }).waitFor();
  await waitForCount(page.locator(".part"), 3);
  expect(await page.locator(".part").nth(1).textContent()).toContain("B2:");
  expect(await poll(async () => (await savedLeaf(api, seeded.storyId)) === [seeded.a1, seeded.b2, seeded.c2].join(","))).toBeTrue();
  expect(await page.evaluate(() => document.activeElement?.textContent?.includes("C2:"))).toBeTrue();

  await page.reload();
  await page.locator(".part").filter({ hasText: "C2:" }).waitFor();
  await waitForCount(page.locator(".part"), 3);
}, 60_000);

test("case 4: mouse: a click selects, hover only highlights, the footer button and "
  + "a double click switch the line", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page);

  await options(page).filter({ hasText: "C2:" }).hover();
  await waitForSelected(page, "C1:");
  await options(page).filter({ hasText: "C2:" }).click();
  await waitForSelected(page, "C2:");
  await page.getByRole("button", { name: "Switch line" }).click();
  await waitForHash(page, new RegExp(`/story/${seeded.storyId}$`));
  await page.locator(".part").filter({ hasText: "C2:" }).waitFor();
  expect(await poll(async () => (await savedLeaf(api, seeded.storyId)) === [seeded.a1, seeded.b2, seeded.c2].join(","))).toBeTrue();

  await page.getByRole("button", { name: "Map (m)" }).click();
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  await showTree(page);
  await options(page).filter({ hasText: "C1:" }).dblclick();
  await waitForHash(page, new RegExp(`/story/${seeded.storyId}$`));
  await page.locator(".part").filter({ hasText: "C1:" }).waitFor();
  expect(await poll(async () => (await savedLeaf(api, seeded.storyId)) === [seeded.a1, seeded.b1, seeded.c1].join(","))).toBeTrue();
}, 60_000);

test("case 5: Enter on a node of the reading line goes to the part without a request", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page);
  await page.keyboard.press("ArrowUp");
  await waitForSelected(page, "B1:");
  await page.getByRole("button", { name: "Go to part" }).waitFor();
  const before = await api.loadStory(seeded.storyId);
  await page.keyboard.press("Enter");

  await waitForHash(page, new RegExp(`/story/${seeded.storyId}$`));
  await page.locator(".part").first().waitFor();
  expect(await poll(async () => await page.evaluate(() => document.activeElement?.textContent?.includes("B1:") === true))).toBeTrue();
  const after = await api.loadStory(seeded.storyId);
  expect(after.path.map((node) => node.id)).toEqual(before.path.map((node) => node.id));
  expect(after.aggregateVersion).toEqual(before.aggregateVersion);
}, 60_000);

test("case 6: a toggles sketches in the tree view, and the fold row does too", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const seeded = await seedForkedStory(await openInspectionApi(web));
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page);
  const toggle = page.getByRole("button", { name: "Sketches" });
  expect(await toggle.getAttribute("aria-pressed")).toBe("false");
  const folded = await options(page).count();
  await page.getByRole("button", { name: "1 sketch" }).waitFor();

  await page.keyboard.press("a");
  await waitForCount(options(page), folded + 1);
  await options(page).filter({ hasText: "B3:" }).waitFor();
  expect(await toggle.getAttribute("aria-pressed")).toBe("true");
  expect(await page.getByRole("button", { name: "1 sketch" }).count()).toBe(0);
  await screenshot(page, "tree-sketches");

  await toggle.click();
  await waitForCount(options(page), folded);
  await page.getByRole("button", { name: "1 sketch" }).click();
  await waitForCount(options(page), folded + 1);
}, 60_000);

test("case 7: the map opens in the path view, ←→ reach a middle part of another "
  + "line, and Enter switches there", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page, "path");

  const pathButton = page.getByRole("button", { name: "Path" });
  expect(await poll(async () => (await pathButton.getAttribute("aria-pressed")) === "true")).toBeTrue();
  await waitForCount(options(page), 3);
  await waitForSelected(page, "C1:");
  await screenshot(page, "path");
  await page.keyboard.press("ArrowUp");
  await waitForSelected(page, "B1:");
  await page.keyboard.press("ArrowRight");
  await waitForSelected(page, "B2:");
  expect(await options(page).nth(2).textContent()).toContain("C2:");
  await page.keyboard.press("ArrowLeft");
  await waitForSelected(page, "B1:");
  await page.keyboard.press("ArrowRight");
  await waitForSelected(page, "B2:");
  await page.keyboard.press("Enter");

  await waitForHash(page, new RegExp(`/story/${seeded.storyId}$`));
  await page.locator(".part").filter({ hasText: "B2:" }).waitFor();
  expect(await poll(async () => (await savedLeaf(api, seeded.storyId)) === [seeded.a1, seeded.b2, seeded.c2].join(","))).toBeTrue();
  expect(await page.evaluate(() => document.activeElement?.textContent?.includes("B2:"))).toBeTrue();
}, 60_000);

test("case 8: a running Continue refuses a switch with a toast, Esc closes the map "
  + "without stopping it, and the stop bar on the map page stops it", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, [DRY_RUN_WORD_DELAY_VARIABLE]: "200" }
  );
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.locator(".part").filter({ hasText: "C1:" }).waitFor();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Stop" }).waitFor();

  await page.getByRole("button", { name: "Map (m)" }).click();
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  await showTree(page);
  await page.keyboard.press("ArrowRight");
  await waitForSelected(page, "C2:");
  await page.keyboard.press("Enter");
  await page.getByText(STORY_LOCKED_TOAST).waitFor();
  expect(await page.evaluate(() => location.hash)).toMatch(/\/map$/);
  expect(await savedLeaf(api, seeded.storyId)).toContain(seeded.c1);

  // Esc belongs to the map: it closes the page, and the run goes on.
  await page.keyboard.press("Escape");
  await waitForHash(page, new RegExp(`/story/${seeded.storyId}$`));
  await page.getByRole("button", { name: "Stop" }).waitFor();
  // Wait until prose (not only reasoning) has streamed into the part.
  const leafProse = page.locator(".part").filter({ hasText: "C1:" }).locator(".prose");
  expect(await poll(async () => ((await leafProse.textContent()) ?? "").length > 60, 30_000)).toBeTrue();
  await page.getByRole("button", { name: "Map (m)" }).click();
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  await showTree(page);

  await page.getByRole("button", { name: "Stop" }).click();
  await waitForCount(page.getByRole("button", { name: "Stop" }), 0);
  const savedLeafText = async (): Promise<string> => (await api.loadStory(seeded.storyId)).path.at(-1)!.text ?? "";
  expect(await poll(async () => (await savedLeafText()).length > 60)).toBeTrue();
}, 90_000);

test("case 9: an open editor blocks a switch under it, and its draft survives the "
  + "round trip through the map", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.locator(".part").filter({ hasText: "B1:" }).click();
  await page.keyboard.press("e");
  const box = page.getByRole("textbox", { name: "Text of part 2" });
  await box.waitFor();
  await box.fill("B1: a draft that is not saved yet.");

  await page.getByRole("button", { name: "Map (m)" }).click();
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  await showTree(page);
  await options(page).filter({ hasText: "C2:" }).dblclick();
  await page.getByText(EDITOR_OPEN_TOAST).waitFor();
  expect(await page.evaluate(() => location.hash)).toMatch(/\/map$/);

  await page.keyboard.press("Escape");
  await waitForHash(page, new RegExp(`/story/${seeded.storyId}$`));
  await page.getByRole("textbox", { name: "Text of part 2" }).waitFor();
  expect(await page.getByRole("textbox", { name: "Text of part 2" }).inputValue()).toBe("B1: a draft that is not saved yet.");
  expect(await savedLeaf(api, seeded.storyId)).toBe([seeded.a1, seeded.b1, seeded.c1].join(","));
}, 60_000);

test("case 10: a switch that fails reloads the story, and the row is gone", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page);
  await page.keyboard.press("ArrowRight");
  await waitForSelected(page, "C2:");

  // Another window prunes that line while the map is open.
  await api.deleteNode(seeded.storyId, seeded.b2, 2);
  await page.keyboard.press("Enter");
  await page.getByText(/Switch take failed|reloaded/).waitFor();
  expect(await poll(async () => (await options(page).filter({ hasText: "C2:" }).count()) === 0)).toBeTrue();
  expect(await page.evaluate(() => location.hash)).toMatch(/\/map$/);
  expect(await savedLeaf(api, seeded.storyId)).toBe([seeded.a1, seeded.b1, seeded.c1].join(","));
}, 60_000);

test("case 11: a large tree keeps the DOM small, parks overflow lines, scrolls with "
  + "the cursor, and a deep switch lands", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedLargeStory(api);
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.locator(".part").first().waitFor();
  await page.getByRole("button", { name: "Map (m)" }).click();
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  await showTree(page);

  const stats = `${seeded.lines} lines · ${seeded.parts.toLocaleString("en-US")} parts · ${seeded.forks} forks`;
  expect(await poll(async () => ((await page.locator(".map-stats").textContent()) ?? "").includes(stats))).toBeTrue();
  expect((await options(page).count()) <= 80).toBeTrue();
  // The cursor starts at the end of the reading line; the fan sits near the top (part 21).
  await page.getByRole("listbox", { name: "Story map" }).evaluate((list) => { list.scrollTop = 560; });
  await page.waitForTimeout(500);
  await screenshot(page, "large-top");
  expect(await poll(async () => (await page.locator(".lane-parked").count()) > 0)).toBeTrue();
  expect((await options(page).count()) <= 80).toBeTrue();
  await screenshot(page, "large");

  const started = Date.now();
  for (let step = 0; step < 300; step += 1) await page.keyboard.press("ArrowUp");
  expect((Date.now() - started) < 45_000).toBeTrue();
  const inView = await page.evaluate(() => {
    const list = document.querySelector('[role="listbox"]')!.getBoundingClientRect();
    const row = document.querySelector('[role="option"][aria-selected="true"]')?.getBoundingClientRect();
    return row !== undefined && row.top >= list.top - 1 && row.bottom <= list.bottom + 1;
  });
  expect(inView).toBeTrue();
  expect((await options(page).count()) <= 80).toBeTrue();

  // Across to the next lane lands on a branch end; Enter switches to it.
  await page.keyboard.press("ArrowRight");
  const label = (await selected(page).textContent()) ?? "";
  expect(label).toMatch(/Branch \d+ tail|Fan \d+ tail|Sketch/);
  await page.keyboard.press("Enter");
  await waitForHash(page, new RegExp(`/story/${seeded.storyId}$`));
  await page.locator(".part").first().waitFor();
  const saved = await api.loadStory(seeded.storyId);
  const leaf = saved.path.at(-1)!;
  expect(leaf.text).toMatch(/^(Branch|Fan) \d+ tail/);
  expect((saved.path.length) > 100).toBeTrue();
}, 240_000);

test("case 12: a narrow window has no horizontal overflow in either view", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const seeded = await seedForkedStory(await openInspectionApi(web), { chapterBreakTitle: "A very long chapter title to ellipsize" });
  const page = await openTestPage(await sharedBrowser(), { viewport: { width: 375, height: 700 } });
  await openStoryPage(page, web, seeded.storyId);
  await page.locator(".part").first().waitFor();
  await page.getByRole("button", { name: "Map (m)" }).click();
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  await showTree(page);
  const overflow = (): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect((await overflow()) <= 0).toBeTrue();
  expect(await page.evaluate(() => document.querySelector('[role="listbox"]')!.scrollWidth <= document.querySelector('[role="listbox"]')!.clientWidth)).toBeTrue();
  const close = await page.getByRole("button", { name: "Close map (Esc)" }).boundingBox();
  expect((close!.x + close!.width) <= 375).toBeTrue();
  await screenshot(page, "narrow-tree");
  await page.keyboard.press("m");
  await waitForCount(options(page), 3);
  expect((await overflow()) <= 0).toBeTrue();
  await screenshot(page, "narrow-path");
}, 60_000);

test("case 13: tag and chapter chips show on the rows", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api, { chapterBreakTitle: "The Door" });
  await api.putBookmark(seeded.storyId, seeded.c1, "Main route", "Canon");
  await api.putBookmark(seeded.storyId, seeded.c2, "Other route", "Alt");
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page);
  expect(await options(page).filter({ hasText: "B1:" }).textContent()).toContain("§ The Door");
  expect(await options(page).filter({ hasText: "C1:" }).textContent()).toContain("Main route");
  expect(await options(page).filter({ hasText: "Other route" }).count()).toBe(1);
  await screenshot(page, "chips");
  await page.emulateMedia({ colorScheme: "dark" });
  await screenshot(page, "chips-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("m");
  await waitForCount(options(page), 3);
  expect(await options(page).filter({ hasText: "B1:" }).textContent()).toContain("§ The Door");
}, 60_000);

test("case 14: a line untouched for weeks folds into a cold row that Enter unfolds", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const seeded = await seedForkedStory(await openInspectionApi(web));
  const page = await openTestPage(await sharedBrowser());
  // The page's clock runs 60 days ahead; timers keep running natively.
  await page.clock.setFixedTime(new Date(Date.now() + 60 * 86_400_000));
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page);
  const cold = options(page).filter({ hasText: /cold \d+ wks/ });
  await waitForCount(cold, 1);
  expect(await options(page).filter({ hasText: "C2:" }).count()).toBe(0);
  expect(await page.locator(".map-stats").textContent()).toContain("1 cold line");
  await screenshot(page, "cold");

  await page.keyboard.press("ArrowRight");
  await waitForSelected(page, /cold \d+ wks/);
  await page.getByRole("button", { name: "Unfold" }).waitFor();
  await page.keyboard.press("Enter");
  await waitForCount(cold, 0);
  await waitForSelected(page, "C2:");
  expect(await page.evaluate(() => location.hash)).toMatch(/\/map$/);
}, 60_000);

/** Saves `web-10j-<name>.png` when `AI_1667_MAP_SHOTS` names a directory. */
async function shot(page: Page, name: string): Promise<void> {
  const directory = process.env.AI_1667_MAP_SHOTS;
  if (directory === undefined || directory === "") return;
  await page.screenshot({ path: `${directory}/web-10j-${name}.png` });
}

async function pressedView(page: Page): Promise<string> {
  for (const name of ["Path", "Tree", "Mass"]) {
    if ((await page.getByRole("button", { name, exact: true }).getAttribute("aria-pressed")) === "true") return name;
  }
  return "";
}

test("case 15: m cycles path, tree and mass; s changes the order and the sort label", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  await api.putBookmark(seeded.storyId, seeded.c1, "Alpha", "");
  await api.putBookmark(seeded.storyId, seeded.c2, "Zulu", "");
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page, "path");
  expect(await pressedView(page)).toBe("Path");

  await page.keyboard.press("m");
  expect(await poll(async () => (await pressedView(page)) === "Tree")).toBeTrue();
  await page.keyboard.press("m");
  expect(await poll(async () => (await pressedView(page)) === "Mass")).toBeTrue();
  // The mass view: the biggest line first, and the cursor on the line you are on.
  await waitForCount(options(page), 2);
  expect(await options(page).first().textContent()).toContain("Zulu");
  await waitForSelected(page, "Alpha");
  await shot(page, "mass");

  const sort = page.getByRole("button", { name: /^Sort:/ });
  expect(await sort.textContent()).toContain("largest first");
  await page.keyboard.press("s");
  await waitForText(sort, "recent first");
  await page.keyboard.press("s");
  await waitForText(sort, "deepest first");
  await page.keyboard.press("s");
  await waitForText(sort, "alphabetical");
  expect(await options(page).first().textContent()).toContain("Alpha");
  await page.keyboard.press("s");
  await waitForText(sort, "largest first");
  expect(await options(page).first().textContent()).toContain("Zulu");

  // The mass view walks and follows a line.
  await page.keyboard.press("ArrowUp");
  await waitForSelected(page, "Zulu");
  await page.keyboard.press("l");
  expect(await poll(async () => (await pressedView(page)) === "Path")).toBeTrue();
  await waitForSelected(page, "C2:");
  await page.keyboard.press("m");
  await page.keyboard.press("m");
  await page.keyboard.press("m");
  expect(await poll(async () => (await pressedView(page)) === "Path")).toBeTrue();
}, 60_000);

async function waitForText(locator: Locator, text: string): Promise<void> {
  expect(await poll(async () => ((await locator.textContent()) ?? "").includes(text))).toBeTrue();
}

test("case 16: in the tree, l walks the reading line and Tab opens a lane-1 row in the path view", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const seeded = await seedForkedStory(await openInspectionApi(web));
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page);
  await waitForSelected(page, "C1:");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await waitForSelected(page, "A1:");
  // Lane 0 is the reading line: l walks down it.
  await page.keyboard.press("l");
  await waitForSelected(page, "B1:");
  await page.keyboard.press("l");
  await waitForSelected(page, "C1:");

  await page.keyboard.press("ArrowRight");
  await waitForSelected(page, "C2:");
  await page.keyboard.press("Tab");
  expect(await poll(async () => (await pressedView(page)) === "Path")).toBeTrue();
  await waitForSelected(page, "C2:");
  // The path view is the line of C2: its parts are A1, B2 and C2.
  expect(await options(page).count()).toBe(3);
  expect(await options(page).nth(1).textContent()).toContain("B2:");
  await shot(page, "path-from-tree");
}, 60_000);

test("case 17: f lenses a Fact and marks its rows, f again goes on, Esc closes the lens and then the map", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const door = await api.createFact(seeded.storyId, { name: "The door", text: "The door is open." });
  await api.createFactState!(seeded.storyId, door.facts[0]!.id, { anchorPartId: seeded.b1, text: "The door is locked." });
  await api.createFact(seeded.storyId, { name: "The window", text: "The window is shut." });
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page);

  const lens = page.getByRole("region", { name: "Fact lens" });
  await page.keyboard.press("f");
  await lens.waitFor();
  expect(await lens.textContent()).toContain("The door");
  // The state anchored at B1 is marked on its row.
  await waitForCount(page.getByText("Fact state 2"), 1);
  expect(await options(page).filter({ hasText: "B1:" }).textContent()).toContain("Fact state 2");
  await shot(page, "lens");

  await page.keyboard.press("f");
  await waitForText(lens, "The window");
  await waitForCount(page.getByText("Fact state 2"), 0);
  await page.keyboard.press("Tab");
  await waitForText(lens, "The door");

  await page.keyboard.press("Escape");
  await waitForCount(lens, 0);
  expect(await page.evaluate(() => location.hash)).toMatch(/\/map$/);
  await page.keyboard.press("Escape");
  await waitForHash(page, new RegExp(`/story/${seeded.storyId}$`));
}, 60_000);

test("case 18: in the path view D deletes the cursor's take after a confirm and t tags its line", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await openMapWithKey(page, "path");
  await waitForSelected(page, "C1:");

  // Part 2 shows B1; → moves to the take B2, which is not on the reading line.
  await page.keyboard.press("ArrowUp");
  await waitForSelected(page, "B1:");
  await page.keyboard.press("ArrowRight");
  await waitForSelected(page, "B2:");
  await page.keyboard.press("Shift+D");
  const dialog = page.getByRole("dialog", { name: "Delete part" });
  await dialog.waitFor();
  expect(await dialog.textContent()).toContain("Delete part 2 and the 1 part below it?");
  await shot(page, "delete");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await waitForCount(dialog, 0);
  expect((await api.loadStory(seeded.storyId)).nodes.some((node) => node.id === seeded.b2)).toBeTrue();

  await page.keyboard.press("Shift+D");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await waitForCount(dialog, 0);
  expect(await poll(async () => {
    const saved = await api.loadStory(seeded.storyId);
    return !saved.nodes.some((node) => node.id === seeded.b2 || node.id === seeded.c2);
  })).toBeTrue();
  const after = await api.loadStory(seeded.storyId);
  expect(after.path.map((node) => node.id).join(",")).toBe([seeded.a1, seeded.b1, seeded.c1].join(","));
  expect(after.nodes.some((node) => node.id === seeded.b3)).toBeTrue();

  // The cursor stays on the map; t tags the line the cursor's take belongs to.
  await page.keyboard.press("t");
  const popover = page.getByRole("dialog", { name: "Tag line" });
  await popover.waitFor();
  await popover.getByRole("textbox", { name: "Name" }).fill("Kept");
  await shot(page, "tag");
  await popover.getByRole("button", { name: "Save" }).click();
  await waitForCount(popover, 0);
  expect(await poll(async () => (await api.loadStory(seeded.storyId)).tags.some((tag) => tag.name === "Kept"))).toBeTrue();
  expect(await page.evaluate(() => location.hash)).toMatch(/\/map$/);
}, 60_000);

test("case 19: during a slow Continue and a slow retake the map marks the node being written, "
  + "and the stop bar stops it", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, [DRY_RUN_WORD_DELAY_VARIABLE]: "200" }
  );
  const seeded = await seedForkedStory(await openInspectionApi(web));
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.locator(".part").filter({ hasText: "C1:" }).waitFor();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Stop" }).waitFor();
  await page.getByRole("button", { name: "Map (m)" }).click();
  await page.getByRole("listbox", { name: "Story map" }).waitFor();

  // A Continue grows the leaf: its row says so.
  const writing = options(page).filter({ hasText: "Writing…" });
  await waitForCount(writing, 1);
  expect(await writing.textContent()).toContain("C1:");
  await page.getByRole("button", { name: "Stop" }).click();
  await waitForCount(page.getByRole("button", { name: "Stop" }), 0);
  await waitForCount(writing, 0);

  // A retake writes a new take: a pending row appears beside C1.
  await page.keyboard.press("Escape");
  await waitForHash(page, new RegExp(`/story/${seeded.storyId}$`));
  await page.locator(".part").filter({ hasText: "C1:" }).waitFor();
  await page.keyboard.press("r");
  await page.getByRole("button", { name: "Stop" }).waitFor();
  await page.getByRole("button", { name: "Map (m)" }).click();
  await page.getByRole("listbox", { name: "Story map" }).waitFor();
  await showTree(page);
  await waitForCount(writing, 1);
  await shot(page, "writing");
  await page.getByRole("button", { name: "Stop" }).click();
  await waitForCount(page.getByRole("button", { name: "Stop" }), 0);
  await waitForCount(writing, 0);
}, 90_000);
