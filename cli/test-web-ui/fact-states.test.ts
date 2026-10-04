import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
import { cleanupWebProcesses, scratchProject, spawnWeb, type ReadyWeb } from "../test/web-e2e-fixture.js";
import {
  afterAllHook,
  cleanupWebUiPages,
  collectPageDiagnostics,
  launchChrome,
  openInspectionApi,
  openTestPage,
  seedForkedStory,
  type ForkedStory
} from "./web-ui-fixture.js";

/**
 * Fact states in a real browser (#409 step 7c): the part menu's fact items,
 * the ◆ mark, the states list of the editor, pick mode, and a fact from
 * selected text. Every case checks the SAVED story through a second connection.
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

async function spawnStatesWeb(): Promise<ReadyWeb> {
  const project = await scratchProject();
  return await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, [DRY_RUN_WORD_DELAY_VARIABLE]: "20" }
  );
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
  expect(await poll(async () => (await locator.count()) === count, timeoutMs)).toBeTrue();
}

async function waitForAttribute(locator: Locator, name: string, value: string): Promise<void> {
  expect(await poll(async () => (await locator.getAttribute(name)) === value)).toBeTrue();
}

/** Saves a screenshot as `web-<name>.png` into the directory named by
 * `AI_1667_WEB_UI_SCREENSHOTS`; does nothing when it is not set. */
async function screenshot(page: Page, name: string): Promise<void> {
  const dir = process.env.AI_1667_WEB_UI_SCREENSHOTS;
  if (dir === undefined) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/web-${name}.png` });
}

function part(page: Page, text: string): Locator {
  return page.locator(".part").filter({ hasText: text });
}

async function seedForked(web: ReadyWeb): Promise<ForkedStory & { api: Awaited<ReturnType<typeof openInspectionApi>> }> {
  const api = await openInspectionApi(web);
  return { ...(await seedForkedStory(api)), api };
}

async function openStory(web: ReadyWeb, storyId: string): Promise<Page> {
  const page = await openTestPage(await sharedBrowser(), { viewport: { width: 1400, height: 900 } });
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  return page;
}

const panel = (page: Page): Locator => page.getByRole("complementary", { name: "Facts" });
const rows = (page: Page): Locator => panel(page).getByRole("list", { name: "Facts" }).getByRole("listitem");
const editor = (page: Page): Locator => panel(page).getByRole("form");
const menu = (page: Page, partNumber: number): Locator => page.getByRole("menu", { name: `Actions for part ${partNumber}` });

async function openPartMenu(page: Page, partNumber: number): Promise<Locator> {
  await page.getByRole("button", { name: "Part actions (x)" }).nth(partNumber - 1).click();
  const opened = menu(page, partNumber);
  await opened.waitFor();
  return opened;
}

test("case 1: Fact from here anchors a state; the ◆ shows on that part and goes with the line", async () => {
  const web = await spawnStatesWeb();
  const seeded = await seedForked(web);
  const page = await openStory(web, seeded.storyId);
  const diagnostics = await collectPageDiagnostics(page);
  await part(page, "B1:").click();
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");

  await (await openPartMenu(page, 2)).getByRole("menuitem", { name: "Fact from here" }).click();
  await panel(page).waitFor();
  await editor(page).getByRole("textbox", { name: "Text" }).fill("From B1 on, the door is locked.");
  await editor(page).getByRole("button", { name: "Save" }).click();
  await waitForCount(editor(page), 0);

  const saved = (await seeded.api.loadStory(seeded.storyId)).facts;
  expect(saved).toHaveLength(1);
  expect(saved[0]!.states[0]).toMatchObject({ anchorPartId: seeded.b1, text: "From B1 on, the door is locked." });
  const mark = part(page, "B1:").getByRole("button", { name: "1 fact state here (f)" });
  await mark.waitFor();
  await screenshot(page, "7bc-fact-mark");
  expect(await rows(page).first().textContent()).toContain("st.1/1");

  // Another take of part 2 is another line: no mark, and the fact is elsewhere.
  await part(page, "B1:").focus();
  await page.keyboard.press("ArrowRight");
  await part(page, "B2:").waitFor();
  expect(await page.getByRole("button", { name: /fact states? here/ }).count()).toBe(0);
  await panel(page).getByRole("button", { name: "Elsewhere", exact: true }).click();
  await waitForCount(rows(page), 1);
  expect(await rows(page).first().textContent()).toContain("⊘");

  // Back on the first line, the mark opens Facts narrowed to this part.
  await part(page, "B2:").focus();
  await page.keyboard.press("ArrowLeft");
  await part(page, "B1:").getByRole("button", { name: "1 fact state here (f)" }).click();
  await panel(page).getByRole("button", { name: /^At part 2/ }).waitFor();
  await waitForCount(rows(page), 1);
  await page.waitForTimeout(300);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 90_000);

test("case 2: New fact state picks a fact, saves a second state, and that state is in effect here", async () => {
  const web = await spawnStatesWeb();
  const seeded = await seedForked(web);
  await seeded.api.createFact(seeded.storyId, { name: "The door", text: "The door is open." });
  await seeded.api.createFact(seeded.storyId, { name: "The window", text: "The window is shut." });
  const page = await openStory(web, seeded.storyId);
  // Facts is already open when the menu action starts the pick.
  await page.keyboard.press("f");
  await waitForCount(rows(page), 2);
  await part(page, "B1:").click();
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");

  await (await openPartMenu(page, 2)).getByRole("menuitem", { name: "New fact state" }).click();
  await panel(page).getByText("Pick the fact for a new state at part 2.").waitFor();
  await screenshot(page, "7bc-fact-pick");
  // The picker has the keyboard: the arrows move its row and Enter picks it.
  await page.keyboard.press("ArrowDown");
  await waitForAttribute(rows(page).nth(1), "aria-current", "true");
  await page.keyboard.press("ArrowUp");
  await waitForAttribute(rows(page).first(), "aria-current", "true");
  await page.keyboard.press("Enter");
  const body = editor(page).getByRole("textbox", { name: "Text" });
  await body.waitFor();
  expect(await body.inputValue()).toBe("The door is open.");
  await body.fill("The door is locked.");
  await editor(page).getByRole("button", { name: "Save" }).click();
  await waitForCount(editor(page), 0);

  const fact = (await seeded.api.loadStory(seeded.storyId)).facts[0]!;
  expect(fact.states).toHaveLength(2);
  expect(fact.states[0]).toMatchObject({ text: "The door is open." });
  expect(fact.states[1]).toMatchObject({ anchorPartId: seeded.b1, text: "The door is locked." });
  expect(await rows(page).first().textContent()).toContain("st.2/2");

  await rows(page).first().click();
  const states = editor(page).getByRole("region", { name: "States" });
  await states.waitFor();
  await screenshot(page, "7bc-fact-states");
  expect(await states.getByRole("listitem").count()).toBe(2);
  expect(await states.getByRole("listitem").nth(1).textContent()).toContain("in effect");
  // The editor opened on the state in effect.
  expect(await editor(page).getByRole("textbox", { name: "Text" }).inputValue()).toBe("The door is locked.");
}, 90_000);

test("case 3: End fact here ends the fact; it shows under Ended on that line", async () => {
  const web = await spawnStatesWeb();
  const seeded = await seedForked(web);
  await seeded.api.createFact(seeded.storyId, { name: "The storm", text: "A storm is coming." });
  const page = await openStory(web, seeded.storyId);
  await part(page, "C1:").click();
  await waitForAttribute(part(page, "C1:"), "aria-current", "true");

  await (await openPartMenu(page, 3)).getByRole("menuitem", { name: "End fact here" }).click();
  await panel(page).getByText("Pick the fact that ends at part 3.").waitFor();
  await page.keyboard.press("Enter");
  expect(await poll(async () => {
    const fact = (await seeded.api.loadStory(seeded.storyId)).facts[0]!;
    return fact.states.some((state) => "ends" in state && state.anchorPartId === seeded.c1);
  })).toBeTrue();
  await panel(page).getByRole("button", { name: "Ended", exact: true }).click();
  await waitForCount(rows(page), 1);
  expect(await rows(page).first().textContent()).toContain("✕");

  // The line without the end still has the fact in force.
  await part(page, "C1:").focus();
  await page.keyboard.press("ArrowUp");
  await part(page, "B1:").focus();
  await page.keyboard.press("ArrowRight");
  await part(page, "B2:").waitFor();
  await waitForCount(rows(page), 0);
}, 90_000);

test("case 4: a state is deleted from the editor's list after a second click", async () => {
  const web = await spawnStatesWeb();
  const seeded = await seedForked(web);
  const made = await seeded.api.createFact(seeded.storyId, { name: "The door", text: "The door is open." });
  const factId = made.facts[0]!.id;
  await seeded.api.createFactState!(seeded.storyId, factId, { text: "The door is locked.", anchorPartId: seeded.b1 });
  const page = await openStory(web, seeded.storyId);

  await page.keyboard.press("f");
  await waitForCount(rows(page), 1);
  await page.keyboard.press("Enter");
  const states = editor(page).getByRole("region", { name: "States" });
  await waitForCount(states.getByRole("listitem"), 2);
  await states.getByRole("button", { name: "Delete state 2" }).click();
  expect((await seeded.api.loadStory(seeded.storyId)).facts[0]!.states).toHaveLength(2);
  await states.getByRole("button", { name: "Confirm" }).click();
  await waitForCount(states.getByRole("listitem"), 0);
  expect((await seeded.api.loadStory(seeded.storyId)).facts[0]!.states).toHaveLength(1);
  // The editor reopens on the state that is left.
  expect(await editor(page).getByRole("textbox", { name: "Text" }).inputValue()).toBe("The door is open.");
}, 90_000);

test("case 5: selected text becomes the body of a new fact", async () => {
  const web = await spawnStatesWeb();
  const seeded = await seedForked(web);
  const page = await openStory(web, seeded.storyId);
  await part(page, "B1:").click();
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");
  await page.evaluate(() => {
    const article = document.querySelector('[aria-label="Part 2, take 1 of 3"]')!;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.textContent?.indexOf("first take") ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + "first take".length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error("text not found");
  });

  await page.keyboard.press("x");
  await menu(page, 2).getByRole("menuitem", { name: "New fact from selection" }).click();
  const body = editor(page).getByRole("textbox", { name: "Text" });
  await body.waitFor();
  expect(await body.inputValue()).toBe("first take");
  await editor(page).getByRole("button", { name: "Save" }).click();
  await waitForCount(editor(page), 0);
  expect((await seeded.api.loadStory(seeded.storyId)).facts[0]!.states[0]).toMatchObject({ text: "first take" });

  // Without a selection the item is not offered.
  await part(page, "C1:").click();
  await page.keyboard.press("x");
  await menu(page, 3).waitFor();
  expect(await menu(page, 3).getByRole("menuitem", { name: "New fact from selection" }).count()).toBe(0);
}, 90_000);

/** A fact "The door" with a story-wide state and a second state at B1; the editor is open on the second. */
async function openDoorEditor(web: ReadyWeb): Promise<{ page: Page; seeded: Awaited<ReturnType<typeof seedForked>>; factId: string }> {
  const seeded = await seedForked(web);
  const made = await seeded.api.createFact(seeded.storyId, { name: "The door", text: "The door is open." });
  const factId = made.facts[0]!.id;
  await seeded.api.createFactState!(seeded.storyId, factId, { text: "The door is locked.", anchorPartId: seeded.b1 });
  const page = await openStory(web, seeded.storyId);
  await page.keyboard.press("f");
  await waitForCount(rows(page), 1);
  await page.keyboard.press("Enter");
  await editor(page).getByRole("textbox", { name: "Text" }).waitFor();
  expect(await editor(page).getByRole("textbox", { name: "Text" }).inputValue()).toBe("The door is locked.");
  return { page, seeded, factId };
}

test("case 6: Re-anchor here moves the open state to the part being read", async () => {
  const web = await spawnStatesWeb();
  const { page, seeded } = await openDoorEditor(web);

  await part(page, "C1:").click();
  await waitForAttribute(part(page, "C1:"), "aria-current", "true");
  await editor(page).getByRole("button", { name: "Re-anchor here" }).click();
  await editor(page).getByText("Moves to part 3. Save to keep it.").waitFor();
  await screenshot(page, "10h-reanchor");
  // Nothing is saved before Save.
  expect((await seeded.api.loadStory(seeded.storyId)).facts[0]!.states[1]).toMatchObject({ anchorPartId: seeded.b1 });
  await editor(page).getByRole("button", { name: "Save" }).click();
  await waitForCount(editor(page), 0);
  expect((await seeded.api.loadStory(seeded.storyId)).facts[0]!.states[1]).toMatchObject({
    anchorPartId: seeded.c1, text: "The door is locked."
  });

  // A part that already holds a state of this fact is refused.
  await rows(page).first().click();
  await editor(page).getByRole("region", { name: "States" }).getByRole("button", { name: "Edit state 1" }).click();
  expect(await editor(page).getByRole("textbox", { name: "Text" }).inputValue()).toBe("The door is open.");
  await editor(page).getByRole("button", { name: "Re-anchor here" }).click();
  await page.getByText("This fact already has a state at that part.").first().waitFor();
  expect((await seeded.api.loadStory(seeded.storyId)).facts[0]!.states[0]!.anchorPartId).toBeUndefined();
}, 90_000);

test("case 7: Convert turns a text state into an End State and back", async () => {
  const web = await spawnStatesWeb();
  const { page, seeded } = await openDoorEditor(web);

  await editor(page).getByRole("button", { name: "Convert to end" }).click();
  await editor(page).getByText("This state ends the fact here. It has no text.").waitFor();
  expect(await editor(page).getByRole("textbox", { name: "Text" }).count()).toBe(0);
  await editor(page).getByRole("button", { name: "Save" }).click();
  await waitForCount(editor(page), 0);
  expect((await seeded.api.loadStory(seeded.storyId)).facts[0]!.states[1]).toMatchObject({ anchorPartId: seeded.b1, ends: true });

  await panel(page).getByRole("button", { name: "Ended", exact: true }).click();
  await waitForCount(rows(page), 1);
  await rows(page).first().click();
  await editor(page).getByRole("button", { name: "Convert to text" }).click();
  expect(await editor(page).getByRole("textbox", { name: "Text" }).inputValue()).toBe("The door is open.");
  await editor(page).getByRole("textbox", { name: "Text" }).fill("The door is bricked up.");
  await editor(page).getByRole("button", { name: "Save" }).click();
  await waitForCount(editor(page), 0);
  const state = (await seeded.api.loadStory(seeded.storyId)).facts[0]!.states[1]!;
  expect(state).toMatchObject({ anchorPartId: seeded.b1, text: "The door is bricked up." });
  expect("ends" in state).toBeFalse();
}, 90_000);

test("case 8: Compare shows what the open state changes from the state before it", async () => {
  const web = await spawnStatesWeb();
  const { page } = await openDoorEditor(web);

  await editor(page).getByRole("button", { name: "Compare" }).click();
  const diff = editor(page).getByRole("group", { name: "Compare states" });
  await diff.getByText("Changes from state 1 to state 2").waitFor();
  expect(await diff.getByText("The door is open.").count()).toBe(1);
  expect(await diff.getByText("The door is locked.").count()).toBe(1);
  await screenshot(page, "10h-compare");
  await editor(page).getByRole("button", { name: "Compare" }).click();
  await waitForCount(diff, 0);
}, 90_000);
