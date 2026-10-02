import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb, type ScratchProject } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  collectPageDiagnostics,
  launchChrome,
  openInspectionApi,
  openTestPage,
  seedForkedStory
} from "./web-ui-fixture.js";

/**
 * The writing loop in a real browser (#409 step 6): the composer, retake,
 * and their keys. The dry-run provider is sped up by
 * `AI_1667_DRY_RUN_WORD_DELAY_MS`. Locators use roles and accessible names.
 * Every case that changes the story checks the SAVED story through a second
 * connection, not only what is on screen.
 */

const WORD_DELAY_MS = 20;

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

async function spawnComposeWeb(project: ScratchProject, wordDelayMs = WORD_DELAY_MS): Promise<ReadyWeb> {
  return await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, [DRY_RUN_WORD_DELAY_VARIABLE]: String(wordDelayMs) }
  );
}

async function openStoryPage(page: Page, web: ReadyWeb, storyId: string): Promise<void> {
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
}

function part(page: Page, text: string): Locator {
  return page.locator(".part").filter({ hasText: text });
}

async function poll(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return await check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForCount(locator: Locator, count: number, timeoutMs = 5_000): Promise<void> {
  const ok = await poll(async () => (await locator.count()) === count, timeoutMs);
  expect(ok).toBeTrue();
}

async function waitForAttribute(locator: Locator, name: string, value: string): Promise<void> {
  const ok = await poll(async () => (await locator.getAttribute(name)) === value);
  expect(ok).toBeTrue();
}

/** Saves a screenshot as `web-compose-<name>.png` into the directory named by
 * `AI_1667_WEB_UI_SCREENSHOTS`; does nothing when it is not set. */
async function screenshot(page: Page, name: string): Promise<void> {
  const dir = process.env.AI_1667_WEB_UI_SCREENSHOTS;
  // Let the entrance animations finish first.
  if (dir !== undefined) await page.waitForTimeout(500);
  if (dir !== undefined) await page.screenshot({ path: `${dir}/web-compose-${name}.png` });
}

function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "What happens next?" });
}

async function isFocused(locator: Locator): Promise<boolean> {
  return await locator.evaluate((element) => element === document.activeElement);
}

function stopButton(page: Page): Locator {
  return page.getByRole("button", { name: "Stop" });
}

function continueButton(page: Page): Locator {
  return page.getByRole("button", { name: "Continue" });
}

/** A story `A → B → C` of plain human parts. */
async function seedThreeParts(web: ReadyWeb, title: string) {
  const api = await openInspectionApi(web);
  const created = await api.createStory(title);
  const pA = await api.createNode(created.id, { text: "A: the opening part.", parentId: null });
  const a = pA.path.at(-1)!.id;
  const pB = await api.createNode(created.id, { text: "B: the middle part.", parentId: a });
  const b = pB.path.at(-1)!.id;
  const pC = await api.createNode(created.id, { text: "C: the last part.", parentId: b });
  return { api, storyId: created.id, a, b, c: pC.path.at(-1)!.id };
}

test("case 1: r on a middle part streams a new take in its place, hides the old take and what follows, and lands as take 2 of 2", async () => {
  const project = await scratchProject();
  const web = await spawnComposeWeb(project);
  const seeded = await seedThreeParts(web, "Retake Story");

  const page = await openTestPage(await sharedBrowser());
  const diagnostics = await collectPageDiagnostics(page);
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Retake Story" }).waitFor();
  await waitForCount(page.locator(".part"), 3);

  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");
  await page.keyboard.press("r");

  await waitForCount(page.locator(".part-streaming"), 1);
  await waitForCount(part(page, "C:"), 0);
  await waitForCount(part(page, "B:"), 0);
  expect(await page.locator(".part-streaming .part-number").textContent()).toBe("Part 2");

  await waitForCount(page.locator(".part-streaming"), 0, 10_000);
  await waitForCount(page.locator(".part"), 2);
  const landed = page.locator(".part").nth(1);
  await waitForAttribute(landed, "aria-current", "true");
  await waitForCount(landed.getByRole("button", { name: /^Take \d+ of 2, show every take$/ }), 1);

  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.path.map((node) => node.parentId)).toEqual([null, seeded.a]);
  expect(saved.path[1]!.id).not.toBe(seeded.b);
  expect(saved.path[1]!.text).toContain("dry-run text");
  expect(saved.nodes.filter((node) => node.parentId === seeded.a)).toHaveLength(2);
  expect(await continueButton(page).count()).toBe(1);

  await page.waitForTimeout(300);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 60_000);

async function openSeededPage(web: ReadyWeb, storyId: string, title: string): Promise<Page> {
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, storyId);
  await page.getByRole("heading", { name: title }).waitFor();
  return page;
}

test("case 2: Enter and i focus the composer, and the i is not typed", async () => {
  const project = await scratchProject();
  const web = await spawnComposeWeb(project);
  const seeded = await seedThreeParts(web, "Focus Story");
  const page = await openSeededPage(web, seeded.storyId, "Focus Story");
  const diagnostics = await collectPageDiagnostics(page);
  await part(page, "C:").click();
  await waitForAttribute(part(page, "C:"), "aria-current", "true");

  await page.keyboard.press("i");
  expect(await poll(() => isFocused(composer(page)))).toBeTrue();
  expect(await composer(page).inputValue()).toBe("");

  await page.keyboard.press("Escape");
  expect(await poll(async () => !(await isFocused(composer(page))))).toBeTrue();
  await page.keyboard.press("Enter");
  expect(await poll(() => isFocused(composer(page)))).toBeTrue();
  expect(await composer(page).inputValue()).toBe("");
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 60_000);

test("case 3: Enter on a focused take arrow activates the arrow instead of opening the composer", async () => {
  const project = await scratchProject();
  const web = await spawnComposeWeb(project);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);
  const page = await openSeededPage(web, seeded.storyId, "Forked Story");
  await part(page, "B1:").click();

  const next = page.getByRole("button", { name: /Next take/ }).first();
  await next.focus();
  await page.keyboard.press("Enter");

  await waitForCount(part(page, "B2:"), 1);
  expect(await isFocused(composer(page))).toBeFalse();
}, 60_000);

test("case 4: a direction and Enter write a part that records it; p shows it; Shift+Enter adds a line", async () => {
  const project = await scratchProject();
  // Slow enough that the streaming part is reliably visible before it lands.
  const web = await spawnComposeWeb(project, 60);
  const seeded = await seedThreeParts(web, "Direction Story");
  const page = await openSeededPage(web, seeded.storyId, "Direction Story");
  const diagnostics = await collectPageDiagnostics(page);
  await part(page, "C:").click();

  await page.keyboard.press("i");
  await composer(page).pressSequentially("She turns");
  await page.keyboard.press("Shift+Enter");
  await composer(page).pressSequentially("around.");
  expect(await composer(page).inputValue()).toBe("She turns\naround.");
  expect(await page.locator(".composer-target").textContent()).toContain("after part 3");

  await composer(page).fill("She turns around.");
  await screenshot(page, "composer");
  await page.keyboard.press("Enter");
  await waitForCount(page.locator(".part-streaming"), 1);
  expect(await composer(page).inputValue()).toBe("");
  await waitForCount(page.locator(".part-streaming"), 0, 20_000);
  await waitForCount(page.locator(".part"), 4);

  const saved = await seeded.api.loadStory(seeded.storyId);
  const landed = saved.path.at(-1)!;
  expect(landed.instruction).toBe("She turns around.");
  expect(landed.text).toContain('"She turns around"');

  await part(page, "A:").click();
  await page.keyboard.press("p");
  await waitForCount(page.locator(".part-instruction"), 1);
  expect(await page.locator(".part-instruction").textContent()).toBe("She turns around.");
  await page.waitForTimeout(300);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 60_000);

test("case 5: Escape in the composer during a stream leaves the box without stopping; a second Escape stops", async () => {
  const project = await scratchProject();
  const web = await spawnComposeWeb(project, 60);
  const seeded = await seedThreeParts(web, "Escape Story");
  const page = await openSeededPage(web, seeded.storyId, "Escape Story");
  await part(page, "C:").click();

  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await waitForCount(stopButton(page), 1);
  await page.keyboard.press("i");
  expect(await poll(() => isFocused(composer(page)))).toBeTrue();
  await composer(page).pressSequentially("next idea");

  await page.keyboard.press("Escape");
  expect(await poll(async () => !(await isFocused(composer(page))))).toBeTrue();
  expect(await stopButton(page).count()).toBe(1);
  expect(await composer(page).inputValue()).toBe("next idea");

  await page.keyboard.press("Escape");
  await waitForCount(continueButton(page), 1, 10_000);
  expect(await composer(page).inputValue()).toBe("next idea");
}, 60_000);

test("case 6: a Direct send stopped while the model is still thinking puts the text back", async () => {
  const project = await scratchProject();
  const web = await spawnComposeWeb(project, 250);
  const seeded = await seedThreeParts(web, "Thinking Story");
  const page = await openSeededPage(web, seeded.storyId, "Thinking Story");
  await part(page, "C:").click();

  await page.keyboard.press("i");
  await composer(page).fill("She never turns around.");
  await page.keyboard.press("Enter");
  await waitForCount(stopButton(page), 1);
  expect(await composer(page).inputValue()).toBe("");
  await page.keyboard.press("Escape");
  await waitForCount(continueButton(page), 1, 10_000);

  expect(await composer(page).inputValue()).toBe("She never turns around.");
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.path).toHaveLength(3);
}, 60_000);

test("case 7: Ctrl+Up and, on an empty box, Up recall the last direction", async () => {
  const project = await scratchProject();
  const web = await spawnComposeWeb(project);
  const seeded = await seedThreeParts(web, "History Story");
  const page = await openSeededPage(web, seeded.storyId, "History Story");
  await part(page, "C:").click();

  await page.keyboard.press("i");
  await composer(page).fill("Rain starts.");
  await page.keyboard.press("Enter");
  await waitForCount(continueButton(page), 1, 10_000);

  await page.keyboard.press("i");
  await composer(page).fill("half typed");
  await page.keyboard.press("Control+ArrowUp");
  expect(await composer(page).inputValue()).toBe("Rain starts.");
  await page.keyboard.press("Control+ArrowDown");
  expect(await composer(page).inputValue()).toBe("half typed");

  await composer(page).fill("");
  await page.keyboard.press("ArrowUp");
  expect(await composer(page).inputValue()).toBe("Rain starts.");

  // Closing a retake never disturbs an unsent Direct draft that a walk holds.
  await page.keyboard.press("Control+ArrowDown");
  await composer(page).fill("unsent draft");
  await page.keyboard.press("Control+ArrowUp");
  expect(await composer(page).inputValue()).toBe("Rain starts.");
  await page.keyboard.press("Escape");
  await part(page, "C:").click();
  await page.keyboard.press("Shift+R");
  await page.getByRole("textbox", { name: "New direction for the retake" }).fill("A retake direction I typed.");
  await page.keyboard.press("Escape");
  await page.keyboard.press("i");
  expect(await composer(page).inputValue()).toBe("Rain starts.");
  await page.keyboard.press("Control+ArrowDown");
  await page.keyboard.press("Control+ArrowDown");
  expect(await composer(page).inputValue()).toBe("unsent draft");
}, 90_000);

test("case 8: while this story writes the box stays editable, a send is refused and the draft stays", async () => {
  const project = await scratchProject();
  const web = await spawnComposeWeb(project, 60);
  const seeded = await seedThreeParts(web, "Lock Story");
  const page = await openSeededPage(web, seeded.storyId, "Lock Story");
  await part(page, "C:").click();

  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await waitForCount(stopButton(page), 1);
  await page.keyboard.press("i");
  await composer(page).fill("a draft while it writes");
  await page.keyboard.press("Enter");

  await page.getByText("Draft kept.").first().waitFor();
  expect(await composer(page).inputValue()).toBe("a draft while it writes");
  expect(await stopButton(page).count()).toBe(1);
}, 60_000);


test("case 9: R opens retake mode filled with the old direction; the new direction is saved; Escape brings the Direct draft back", async () => {
  const project = await scratchProject();
  const web = await spawnComposeWeb(project);
  const api = await openInspectionApi(web);
  const created = await api.createStory("R Story");
  const pA = await api.createNode(created.id, { text: "A: the opening part.", parentId: null });
  const a = pA.path.at(-1)!.id;
  await api.createNode(created.id, { text: "B: the middle part.", parentId: a, instruction: "Go left." });
  const page = await openSeededPage(web, created.id, "R Story");
  const diagnostics = await collectPageDiagnostics(page);
  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");

  await page.keyboard.press("i");
  await composer(page).fill("my direct draft");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Shift+R");
  const retakeBox = page.getByRole("textbox", { name: "New direction for the retake" });
  expect(await poll(() => isFocused(retakeBox))).toBeTrue();
  expect(await retakeBox.inputValue()).toBe("Go left.");
  expect(await page.locator(".composer-target").textContent()).toBe("Retake part 2 — new direction");
  await screenshot(page, "retake");

  await page.keyboard.press("Escape");
  expect(await composer(page).inputValue()).toBe("my direct draft");

  await part(page, "B:").click();
  await page.keyboard.press("Shift+R");
  await retakeBox.fill("Go right.");
  await page.keyboard.press("Enter");
  await waitForCount(page.locator(".part-streaming"), 1);
  expect(await composer(page).inputValue()).toBe("my direct draft");
  await waitForCount(page.locator(".part-streaming"), 0, 10_000);
  await waitForCount(page.locator(".part"), 2);

  const saved = await api.loadStory(created.id);
  expect(saved.path[1]!.instruction).toBe("Go right.");
  expect(saved.path[1]!.parentId).toBe(a);
  expect(saved.nodes.filter((node) => node.parentId === a)).toHaveLength(2);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 60_000);

test("case 11: i focuses the composer even when a button has the keyboard", async () => {
  const project = await scratchProject();
  const web = await spawnComposeWeb(project);
  const seeded = await seedThreeParts(web, "Button Focus");
  const page = await openSeededPage(web, seeded.storyId, "Button Focus");

  await continueButton(page).focus();
  await page.keyboard.press("i");

  expect(await poll(() => isFocused(composer(page)))).toBeTrue();
  expect(await composer(page).inputValue()).toBe("");
}, 60_000);
