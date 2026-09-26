import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import type { StoryNode } from "../../shared/types.js";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb, type ScratchProject } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  launchChrome,
  openInspectionApi,
  openTestPage,
  seedForkedStory,
  type ForkedStory
} from "./web-ui-fixture.js";

/**
 * The manuscript read view (#409 step 4): parts, part focus, take switching,
 * the TUI's own keys, and a durable reading position shared with the TUI.
 * Locators are by role and accessible name — never a CSS class, which the
 * design is free to rename. This project's `bun:test` `expect` is plain
 * (no Playwright matcher extension — see `library-crud.test.ts`'s own
 * `expectHash` for the precedent), so every assertion that needs to wait for
 * a re-render polls through the small helpers below rather than an
 * `expect(locator).toX()` call.
 */

let browser: Browser | null = null;
async function sharedBrowser(): Promise<Browser> {
  browser ??= await launchChrome();
  return browser;
}
afterAllHook(async () => {
  await browser?.close();
});

const configHomes: string[] = [];

afterEach(async () => {
  await cleanupWebUiPages();
  await cleanupWebProcesses();
  await Promise.all(configHomes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Every test's own `XDG_CONFIG_HOME`, so no test reads or writes the real
 * `~/.config` reading-position store. */
async function scratchConfigHome(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-manuscript-config-"));
  configHomes.push(dir);
  return dir;
}

/** `scratchProject()`'s `dataDir` sits under `os.tmpdir()`, which on macOS is
 * itself a symlink (`/var` -> `/private/var`); the project resolver
 * (`server/project-discovery.ts`) realpaths a project directory once it
 * exists, but not before it is first created, so a store-file lookup based
 * on the unresolved path would hash to a different file than a second
 * `1667 web` run (which sees the directory already exists) actually reads
 * from. Only case 9 (which restarts `1667 web` on the same project and
 * checks the on-disk store directly) needs this; canonicalizing the scratch
 * root up front keeps every run's own resolution identical. */
async function canonicalScratchProject(): Promise<ScratchProject> {
  const project = await scratchProject();
  const canonicalRoot = await realpath(path.dirname(project.dataDir));
  return { ...project, dataDir: path.join(canonicalRoot, path.basename(project.dataDir)) };
}

async function spawnScratchWeb(project: ScratchProject, configHome: string): Promise<ReadyWeb> {
  return await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, XDG_CONFIG_HOME: configHome }
  );
}

async function openStoryPage(page: Page, web: ReadyWeb, storyId: string): Promise<void> {
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => {
    location.hash = `#/story/${id}`;
  }, storyId);
}

function part(page: Page, text: string): Locator {
  return page.locator(".part").filter({ hasText: text });
}

function takeCounter(page: Page): Locator {
  return page.getByRole("button", { name: /show every take/ });
}

async function poll(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return await check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForAttribute(locator: Locator, name: string, value: string): Promise<void> {
  const ok = await poll(async () => (await locator.getAttribute(name)) === value);
  expect(ok).toBeTrue();
}

async function waitForCount(locator: Locator, count: number): Promise<void> {
  const ok = await poll(async () => (await locator.count()) === count);
  expect(ok).toBeTrue();
}

async function waitForLabelMatching(locator: Locator, pattern: RegExp): Promise<void> {
  const ok = await poll(async () => pattern.test((await locator.getAttribute("aria-label")) ?? ""));
  expect(ok).toBeTrue();
}

test("case 1: parts open in order, the leaf carries aria-current, directions "
  + "are hidden by default; 'p' and the button show them, and it survives a reload", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const withA1 = await api.loadStory(seeded.storyId);
  const a1Node = withA1.path.find((node) => node.id === seeded.a1)!;
  // `editNode` only reads `node.id`/`node.text` at runtime (it hashes the
  // text to guard the edit) — `StoryPathNode` (what `path` carries) omits
  // `generationRecordIds`, the one field a full `StoryNode` has that it
  // doesn't, so this cast is safe here and in every other case below.
  await api.editNode(seeded.storyId, a1Node as unknown as StoryNode, { instruction: "Open cold, no preamble." });

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  const parts = page.locator(".part");
  await waitForCount(parts, 3);
  expect(await parts.nth(0).textContent()).toContain("A1:");
  expect(await parts.nth(1).textContent()).toContain("B1:");
  expect(await parts.nth(2).textContent()).toContain("C1:");
  await waitForAttribute(part(page, "C1:"), "aria-current", "true");

  const directionsButton = page.getByRole("button", { name: "Show directions" });
  await waitForAttribute(directionsButton, "aria-pressed", "false");
  expect(await page.locator(".part-instruction").count()).toBe(0);

  await page.keyboard.press("p");
  await waitForAttribute(directionsButton, "aria-pressed", "true");
  const instructionText = await page.locator(".part-instruction").textContent();
  expect(instructionText).toContain("Open cold, no preamble.");

  await directionsButton.click();
  await waitForAttribute(directionsButton, "aria-pressed", "false");

  await directionsButton.click();
  await page.reload();
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await waitForAttribute(page.getByRole("button", { name: "Show directions" }), "aria-pressed", "true");
}, 30_000);

test("case 2: focus moves with ↑/↓, g/G, and a click; a 40-part story scrolls "
  + "the focused part into view", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  // Opens on the leaf (C1); ↑ moves to B1, ↑ again to A1, ↓ back to B1.
  await waitForAttribute(part(page, "C1:"), "aria-current", "true");
  await page.keyboard.press("ArrowUp");
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");
  await page.keyboard.press("ArrowUp");
  await waitForAttribute(part(page, "A1:"), "aria-current", "true");
  await page.keyboard.press("ArrowDown");
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");

  await page.keyboard.press("g");
  await waitForAttribute(part(page, "A1:"), "aria-current", "true");
  await page.keyboard.press("Shift+G");
  await waitForAttribute(part(page, "C1:"), "aria-current", "true");

  await part(page, "B1:").click();
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");

  // A 40-part linear story: opening on the leaf must bring part 40 on
  // screen, not merely mark it current off-screen.
  const long = await api.createStory("Long Story");
  let parentId: string | null = null;
  for (let index = 1; index <= 40; index += 1) {
    const created = await api.createNode(long.id, { text: `Part ${index} text.`, parentId });
    parentId = created.path.at(-1)!.id;
  }
  await openStoryPage(page, web, long.id);
  await page.getByRole("heading", { name: "Long Story" }).waitFor();
  const last = part(page, "Part 40 text.");
  await waitForAttribute(last, "aria-current", "true");
  const inViewport = await last.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  expect(inViewport).toBeTrue();
  // Seeds a 40-part story through 40 sequential bridge calls; under a loaded
  // machine that alone can pass 30 s.
}, 60_000);

test("case 3: keyboard take switch — → shows 'Take 2 of 3' and C2; two more "
  + "wraps back to take 1; a second connection's loadStory agrees; a reload keeps it", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  await part(page, "B1:").click();
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");

  await page.keyboard.press("ArrowRight");
  await waitForLabelMatching(takeCounter(page), /Take 2 of 3/);
  await waitForCount(page.locator(".part").filter({ hasText: "C2:" }), 1);

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await waitForLabelMatching(takeCounter(page), /Take 1 of 3/);
  await waitForCount(page.locator(".part").filter({ hasText: "C1:" }), 1);

  const inspected = await api.loadStory(seeded.storyId);
  expect(inspected.path.some((node) => node.id === seeded.b1)).toBeTrue();
  expect(inspected.path.some((node) => node.id === seeded.c1)).toBeTrue();

  await page.reload();
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await waitForLabelMatching(takeCounter(page), /Take 1 of 3/);
}, 30_000);

test("case 4: mouse take switch to a childless take; the peek lists all "
  + "three with 'ends here'/'parts below', a click switches, Escape closes", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  await part(page, "B1:").click();
  const nextArrow = page.getByRole("button", { name: /Next take/ });
  await nextArrow.click();
  await waitForLabelMatching(takeCounter(page), /Take 2 of 3/);
  await nextArrow.click();
  await waitForLabelMatching(takeCounter(page), /Take 3 of 3/);
  // B3 is childless: the line now ends at part 2, with no part 3 below it.
  await waitForCount(page.locator(".part"), 2);
  await waitForCount(page.locator(".part").filter({ hasText: "B3:" }), 1);

  await takeCounter(page).click();
  const peek = page.getByRole("dialog", { name: "Take preview" });
  await peek.waitFor();
  await waitForCount(peek.locator(".take-peek-row"), 3);
  const peekText = (await peek.textContent()) ?? "";
  expect(/ends here/i.test(peekText)).toBeTrue();
  expect(/part.*below/i.test(peekText)).toBeTrue();

  await peek.locator(".take-peek-row").first().click();
  await waitForLabelMatching(takeCounter(page), /Take 1 of 3/);

  await takeCounter(page).click();
  await page.getByRole("dialog", { name: "Take preview" }).waitFor();
  await page.keyboard.press("Escape");
  await waitForCount(page.getByRole("dialog", { name: "Take preview" }), 0);
}, 30_000);

test("case 5: manuscript keys are ignored while search has focus — 'p' types "
  + "instead of toggling directions", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  const search = page.getByRole("searchbox", { name: "Search stories" });
  await search.click();
  await page.keyboard.press("p");
  expect(await search.inputValue()).toBe("p");
  const pressed = await page.getByRole("button", { name: "Show directions" }).getAttribute("aria-pressed");
  expect(pressed).toBe("false");
}, 30_000);

test("case 6: a chapter divider sits where the break is anchored; ]/[ move "
  + "focus across it", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded: ForkedStory = await seedForkedStory(api, { chapterBreakTitle: "The Turn" });

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  const divider = page.locator(".chapter-divider");
  await divider.waitFor();
  const dividerText = await divider.textContent();
  expect(dividerText).toContain("The Turn");
  // The break anchors on B1: chapter one holds A1/B1, chapter two opens at C1.
  const rows = page.locator(".manuscript > li");
  const dividerIndex = await rows.evaluateAll((elements) =>
    elements.findIndex((element) => element.classList.contains("chapter-divider")));
  const b1Index = await rows.evaluateAll((elements) =>
    elements.findIndex((element) => element.textContent?.includes("B1:") ?? false));
  const c1Index = await rows.evaluateAll((elements) =>
    elements.findIndex((element) => element.textContent?.includes("C1:") ?? false));
  expect(dividerIndex).toBeGreaterThan(b1Index);
  expect(dividerIndex).toBeLessThan(c1Index);

  await part(page, "A1:").click();
  await page.keyboard.press("]");
  await waitForAttribute(part(page, "C1:"), "aria-current", "true");
  await page.keyboard.press("[");
  await waitForAttribute(part(page, "A1:"), "aria-current", "true");
}, 30_000);

test("case 7: an external change lands mid-switch and shows the reload toast", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await part(page, "B1:").click();

  // A different client switches the line first, advancing the story's
  // version past what the page's own connection still expects.
  await api.switchLine(seeded.storyId, seeded.b2);

  await page.keyboard.press("ArrowRight");
  await page.getByText("The story changed in another window. It was reloaded.").waitFor();
  await waitForLabelMatching(takeCounter(page), /Take 2 of 3/);
  await waitForCount(page.locator(".part").filter({ hasText: "C2:" }), 1);
}, 30_000);

test("case 8: a human edit made through the inspection connection shows the "
  + "human-edit mark after a reload", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const loaded = await api.loadStory(seeded.storyId);
  const b1Node = loaded.path.find((node) => node.id === seeded.b1)!;
  await api.editNode(seeded.storyId, b1Node as unknown as StoryNode, {
    text: "B1: the first take that follows A1, now edited by hand."
  });

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await waitForCount(page.getByText("now edited by hand"), 1);
  await waitForCount(page.locator(".human-edit-mark"), 1);
  await waitForCount(part(page, "B1:").getByText("human edit"), 1);
}, 30_000);

test("case 9: the focused part's reading position survives a 1667 web "
  + "restart, and a position the TUI store wrote is honored by the web", async () => {
  const project = await canonicalScratchProject();
  const configHome = await scratchConfigHome();
  const first = await spawnScratchWeb(project, configHome);
  const api = await openInspectionApi(first);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, first, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await part(page, "B1:").click();
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");
  // The focus-position write is debounced (~400ms); wait past it before the
  // restart, or the save never reaches disk.
  await page.waitForTimeout(700);

  first.child.kill("SIGINT");
  const exited = await first.exit;
  expect(exited.code).toBe(0);

  const second = await spawnScratchWeb(project, configHome);
  const secondApi = await openInspectionApi(second);
  const secondPage = await openTestPage(await sharedBrowser());
  await openStoryPage(secondPage, second, seeded.storyId);
  await secondPage.getByRole("heading", { name: "Forked Story" }).waitFor();
  await waitForAttribute(part(secondPage, "B1:"), "aria-current", "true");

  // A second story, its position written directly through the same host
  // store the TUI itself writes to (never through the web's own HTTP
  // route), must also be honored on open.
  const otherSeeded = await seedForkedStory(secondApi);
  const { readingPositionStoreFile, markReadingPositionDirty, flushReadingPositionPersist, configureReadingPositionStore } =
    await import("../../host/reading-position-store.js");
  const { projectDirectory } = await import("../../server/project-layout.js");
  const priorConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  try {
    const storeFile = readingPositionStoreFile(projectDirectory(project.dataDir), null);
    configureReadingPositionStore(storeFile);
    markReadingPositionDirty(otherSeeded.storyId, otherSeeded.a1, { file: storeFile });
    flushReadingPositionPersist({ file: storeFile });
  } finally {
    if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfigHome;
  }

  // A fresh page (a fresh bridge connection, and so a fresh
  // once-per-connection positions fetch — `secondPage`'s own connection
  // already cached the positions map before this write landed) is what
  // proves the web reads a position it never wrote itself, not merely one
  // it cached from before this story existed.
  const thirdPage = await openTestPage(await sharedBrowser());
  await openStoryPage(thirdPage, second, otherSeeded.storyId);
  await thirdPage.getByRole("heading", { name: "Forked Story" }).waitFor();
  await waitForAttribute(part(thirdPage, "A1:"), "aria-current", "true");
}, 30_000);

test("case 10: switching to another story and back keeps the moved position, "
  + "in the same tab, before the debounced write could have reached the "
  + "server (review fix: the positions cache learns this tab's own writes)", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const storyA = await seedForkedStory(api);
  const storyB = await seedForkedStory(api);

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, storyA.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await waitForAttribute(part(page, "C1:"), "aria-current", "true");

  await part(page, "B1:").click();
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");

  // Away to story B and straight back, all in the same tab/connection, with
  // no wait — well before the ~400ms debounced write for "B1:" could
  // possibly have reached the server, so only the in-tab record (not a
  // fresh GET) can be what answers this.
  await page.evaluate((id) => {
    location.hash = `#/story/${id}`;
  }, storyB.storyId);
  await waitForAttribute(part(page, "C1:"), "aria-current", "true");
  await page.evaluate((id) => {
    location.hash = `#/story/${id}`;
  }, storyA.storyId);
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");
}, 30_000);

test("case 11: a reload issued inside the reading-position debounce window "
  + "still lands on a just-moved-to part (review fix: the host's GET merges "
  + "its own still-pending write)", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await waitForAttribute(part(page, "C1:"), "aria-current", "true");

  await part(page, "B1:").click();
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");

  // Reload right away: a fresh connection, with no in-tab memory of this
  // move, well inside the debounce window — only a GET that also sees the
  // still-pending (not yet flushed to disk) write can open back on "B1:"
  // instead of falling back to the leaf.
  await page.reload();
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");
}, 30_000);

test("case 12: Alt+-> does not switch takes, so the browser keeps its own "
  + "back/forward (review fix: alt-modified arrows are rejected)", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  await part(page, "B1:").click();
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");
  await waitForLabelMatching(takeCounter(page), /Take 1 of 3/);

  await page.keyboard.press("Alt+ArrowRight");
  // Give an incorrect switch a moment to start, then confirm nothing moved.
  await page.waitForTimeout(200);
  await waitForLabelMatching(takeCounter(page), /Take 1 of 3/);
  await waitForCount(page.locator(".part").filter({ hasText: "C1:" }), 1);

  // The plain key still works — only the Alt-modified chord is rejected.
  await page.keyboard.press("ArrowRight");
  await waitForLabelMatching(takeCounter(page), /Take 2 of 3/);
}, 30_000);
