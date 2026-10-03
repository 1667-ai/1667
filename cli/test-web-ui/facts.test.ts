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
  openTestPage
} from "./web-ui-fixture.js";

/**
 * Facts in a real browser (#409 step 7b): the panel's Facts view, the fact
 * editor, reorder, delete, filters, the budget, the dock, and the draft that
 * survives. Every case checks the SAVED story through a second connection.
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

async function spawnFactsWeb(): Promise<ReadyWeb> {
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

async function openStory(web: ReadyWeb, storyId: string, title: string, width = 1400): Promise<Page> {
  const page = await openTestPage(await sharedBrowser(), { viewport: { width, height: 900 } });
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
  await page.getByRole("heading", { name: title }).waitFor();
  return page;
}

const panel = (page: Page): Locator => page.getByRole("complementary", { name: "Facts" });
const rows = (page: Page): Locator => panel(page).getByRole("list", { name: "Facts" }).getByRole("listitem");
const editor = (page: Page): Locator => panel(page).getByRole("form");
const isFocused = (locator: Locator): Promise<boolean> => locator.evaluate((element) => element === document.activeElement);

test("case 1: f opens Facts and moves focus in; n, Name, Tag, Text and Ctrl+S make a fact", async () => {
  const web = await spawnFactsWeb();
  const seeded = await seedThreeParts(web, "Fact Create");
  const page = await openStory(web, seeded.storyId, "Fact Create");
  const diagnostics = await collectPageDiagnostics(page);
  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");

  await page.keyboard.press("f");
  await panel(page).waitFor();
  expect(await poll(() => isFocused(panel(page)))).toBeTrue();
  await screenshot(page, "7bc-facts-empty");

  await page.keyboard.press("n");
  const name = editor(page).getByRole("textbox", { name: "Name" });
  expect(await poll(() => isFocused(name))).toBeTrue();
  await page.keyboard.type("Mara");
  await editor(page).getByRole("combobox", { name: "Tag" }).fill("people");
  await editor(page).getByRole("textbox", { name: "Text" }).fill("Mara is the lighthouse keeper.");
  await screenshot(page, "7bc-fact-editor");
  await page.keyboard.press("Control+s");

  await waitForCount(editor(page), 0);
  await waitForCount(rows(page), 1);
  expect(await rows(page).first().textContent()).toContain("Mara");
  expect(await rows(page).first().textContent()).toContain("people");
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.facts).toHaveLength(1);
  expect(saved.facts[0]!.name).toBe("Mara");
  expect(saved.facts[0]!.tag).toBe("people");
  expect(saved.facts[0]!.states[0]).toMatchObject({ text: "Mara is the lighthouse keeper." });
  // Esc leaves the panel and hands the keyboard back to the part.
  expect(await poll(() => isFocused(panel(page)))).toBeTrue();
  await page.keyboard.press("Escape");
  await waitForCount(panel(page), 0);
  expect(await poll(() => isFocused(part(page, "B:")))).toBeTrue();
  await page.waitForTimeout(300);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 60_000);

test("case 2: editing the body, keys, activation and priority saves only what changed", async () => {
  const web = await spawnFactsWeb();
  const seeded = await seedThreeParts(web, "Fact Edit");
  await seeded.api.createFact(seeded.storyId, { name: "Mara", tag: "people", text: "Mara keeps the light." });
  const page = await openStory(web, seeded.storyId, "Fact Edit");

  await page.keyboard.press("f");
  await waitForCount(rows(page), 1);
  await page.keyboard.press("Enter");
  const body = editor(page).getByRole("textbox", { name: "Text" });
  await body.waitFor();
  expect(await body.inputValue()).toBe("Mara keeps the light.");
  await body.fill("Mara keeps the light and the keys.");
  await editor(page).getByRole("button", { name: "More" }).click();
  await editor(page).getByRole("radio", { name: "Keyed" }).click();
  await editor(page).getByRole("textbox", { name: "Keys", exact: true }).fill("Mara, keeper");
  await editor(page).getByRole("radio", { name: "High" }).click();
  await screenshot(page, "7bc-fact-more");
  await editor(page).getByRole("button", { name: "Save" }).click();
  await waitForCount(editor(page), 0);

  const fact = (await seeded.api.loadStory(seeded.storyId)).facts[0]!;
  expect(fact.states[0]).toMatchObject({ text: "Mara keeps the light and the keys." });
  expect(fact.activation).toBe("keyed");
  expect(fact.keys).toEqual(["Mara", "keeper"]);
  expect(fact.priority).toBe("high");
  expect(fact.name).toBe("Mara");
  expect(fact.tag).toBe("people");
  expect(await rows(page).first().textContent()).toContain("keyed");

  // A bad value is refused where the writer is, and the draft stays.
  await rows(page).first().click();
  await editor(page).getByRole("button", { name: "More" }).click();
  await editor(page).getByRole("textbox", { name: "Scan depth" }).fill("999");
  await editor(page).getByRole("button", { name: "Save" }).click();
  await page.getByText(/Fact scan depth/).first().waitFor();
  expect(await editor(page).getByRole("textbox", { name: "Scan depth" }).inputValue()).toBe("999");
}, 60_000);

test("case 3: Shift+Down and the Move buttons reorder the facts", async () => {
  const web = await spawnFactsWeb();
  const seeded = await seedThreeParts(web, "Fact Order");
  for (const name of ["One", "Two", "Three"]) await seeded.api.createFact(seeded.storyId, { name, text: `${name} text` });
  const page = await openStory(web, seeded.storyId, "Fact Order");
  const order = async (): Promise<string[]> => (await seeded.api.loadStory(seeded.storyId)).facts.map((fact) => fact.name ?? "");

  await page.keyboard.press("f");
  await waitForCount(rows(page), 3);
  await page.keyboard.press("Shift+ArrowDown");
  expect(await poll(async () => (await order()).join() === "Two,One,Three")).toBeTrue();
  // The selection follows the moved fact.
  expect(await rows(page).nth(1).getAttribute("aria-current")).toBe("true");
  await rows(page).nth(1).getByRole("button", { name: /^Move down/ }).click();
  expect(await poll(async () => (await order()).join() === "Two,Three,One")).toBeTrue();
  await rows(page).nth(2).getByRole("button", { name: /^Move up/ }).click();
  expect(await poll(async () => (await order()).join() === "Two,One,Three")).toBeTrue();
  expect(await rows(page).first().textContent()).toContain("Two");
}, 60_000);

test("case 4: Delete asks first; Cancel keeps the fact, Delete removes it", async () => {
  const web = await spawnFactsWeb();
  const seeded = await seedThreeParts(web, "Fact Delete");
  await seeded.api.createFact(seeded.storyId, { name: "Gone soon", text: "Short lived." });
  const page = await openStory(web, seeded.storyId, "Fact Delete");

  await page.keyboard.press("f");
  await waitForCount(rows(page), 1);
  await page.keyboard.press("Enter");
  await editor(page).getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete fact" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await waitForCount(dialog, 0);
  expect((await seeded.api.loadStory(seeded.storyId)).facts).toHaveLength(1);
  expect(await editor(page).count()).toBe(1);

  await editor(page).getByRole("button", { name: "Delete" }).click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await waitForCount(dialog, 0);
  await waitForCount(editor(page), 0);
  expect((await seeded.api.loadStory(seeded.storyId)).facts).toHaveLength(0);
  await panel(page).getByText("No facts yet").waitFor();
}, 60_000);

test("case 5: the tag and text filters and the scope chips narrow the list", async () => {
  const web = await spawnFactsWeb();
  const seeded = await seedThreeParts(web, "Fact Filters");
  const { api, storyId } = seeded;
  await api.createFact(storyId, { name: "Mara", tag: "people", text: "Keeper of the light." });
  await api.createFact(storyId, { name: "The Reef", tag: "places", text: "Black rocks off the point." });
  const staged = await api.createFact(storyId, { name: "Storm", tag: "rules", text: "It rains in autumn." });
  const stormId = staged.facts.find((fact) => fact.name === "Storm")!.id;
  await api.createFactState!(storyId, stormId, { text: "It storms in autumn.", anchorPartId: seeded.b });
  await api.createFactState!(storyId, stormId, { ends: true, anchorPartId: seeded.c });
  const page = await openStory(web, storyId, "Fact Filters");
  const chip = (name: string): Locator => panel(page).getByRole("button", { name, exact: true });

  await page.keyboard.press("f");
  await waitForCount(rows(page), 3);
  await panel(page).getByRole("textbox", { name: "Filter facts" }).fill("rocks");
  await waitForCount(rows(page), 1);
  expect(await rows(page).first().textContent()).toContain("The Reef");
  await panel(page).getByRole("textbox", { name: "Filter facts" }).fill("");
  await waitForCount(rows(page), 3);

  await panel(page).getByRole("combobox", { name: "Tag" }).selectOption("people");
  await waitForCount(rows(page), 1);
  await panel(page).getByRole("combobox", { name: "Tag" }).selectOption("");

  // The line ends at C, where Storm ended.
  await chip("Ended").click();
  await waitForCount(rows(page), 1);
  expect(await rows(page).first().textContent()).toContain("Storm");
  await chip("This line").click();
  await waitForCount(rows(page), 0);
  await chip("Everywhere").click();
  await waitForCount(rows(page), 3);
  expect(await chip("Everywhere").getAttribute("aria-pressed")).toBe("true");

  // Reordering needs the whole list.
  await chip("Ended").click();
  await waitForCount(rows(page), 1);
  expect(await rows(page).first().getByRole("button", { name: /^Move up/ }).isDisabled()).toBeTrue();
}, 60_000);

test("case 6: the facts budget is set from the panel and cleared by an empty field", async () => {
  const web = await spawnFactsWeb();
  const seeded = await seedThreeParts(web, "Fact Budget");
  const page = await openStory(web, seeded.storyId, "Fact Budget");

  await page.keyboard.press("f");
  await panel(page).getByRole("button", { name: "No facts budget" }).click();
  const field = panel(page).getByRole("textbox", { name: "Facts budget in tokens" });
  await field.fill("500");
  await page.keyboard.press("Enter");
  await panel(page).getByRole("button", { name: "Facts budget: 500 tokens" }).waitFor();
  expect((await seeded.api.loadStory(seeded.storyId)).factsBudgetTokens).toBe(500);

  await panel(page).getByRole("button", { name: "Facts budget: 500 tokens" }).click();
  await field.fill("");
  await page.keyboard.press("Enter");
  await panel(page).getByRole("button", { name: "No facts budget" }).waitFor();
  expect((await seeded.api.loadStory(seeded.storyId)).factsBudgetTokens).toBeUndefined();

  // A bad value is refused and the field stays.
  await panel(page).getByRole("button", { name: "No facts budget" }).click();
  await field.fill("lots");
  await page.keyboard.press("Enter");
  await page.getByText(/must be a whole number of tokens/).first().waitFor();
  expect(await field.inputValue()).toBe("lots");
}, 60_000);

test("case 7: a changed fact draft warns before a reload and stays reachable when the connection is gone", async () => {
  const web = await spawnFactsWeb();
  const seeded = await seedThreeParts(web, "Fact Unsaved");
  const page = await openStory(web, seeded.storyId, "Fact Unsaved");

  await page.keyboard.press("f");
  await page.keyboard.press("n");
  await editor(page).getByRole("textbox", { name: "Text" }).fill("A fact nobody saved.");

  let sawBeforeUnload = false;
  page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") sawBeforeUnload = true;
    void dialog.dismiss();
  });
  await page.reload().catch(() => {});
  expect(sawBeforeUnload).toBeTrue();

  web.child.kill("SIGKILL");
  await web.exit;
  const work = page.getByRole("region", { name: "Unsaved work" });
  await work.waitFor({ timeout: 10_000 });
  expect(await work.getByRole("textbox", { name: "Unsaved fact" }).inputValue()).toContain("A fact nobody saved.");
  await work.getByRole("button", { name: "Copy" }).waitFor();
}, 60_000);

test("case 8: F docks the Facts view without moving focus, and the dock survives a reload", async () => {
  const web = await spawnFactsWeb();
  const seeded = await seedThreeParts(web, "Fact Dock");
  await seeded.api.createFact(seeded.storyId, { name: "Mara", text: "Mara keeps the light." });
  const page = await openStory(web, seeded.storyId, "Fact Dock");
  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");

  await page.keyboard.press("Shift+F");
  await panel(page).waitFor();
  await waitForCount(rows(page), 1);
  expect(await isFocused(part(page, "B:"))).toBeTrue();
  await screenshot(page, "7bc-facts-docked");
  // The part keys still work while the panel is docked.
  await page.keyboard.press("ArrowDown");
  await waitForAttribute(part(page, "C:"), "aria-current", "true");

  await page.reload();
  await page.getByRole("heading", { name: "Fact Dock" }).waitFor();
  await panel(page).waitFor();
  await waitForCount(rows(page), 1);

  await page.keyboard.press("Shift+F");
  await waitForCount(panel(page), 0);
  await page.reload();
  await page.getByRole("heading", { name: "Fact Dock" }).waitFor();
  await waitForCount(panel(page), 0);
}, 60_000);

test("case 9: a fact changed in another window keeps the draft; the next Save overwrites", async () => {
  const web = await spawnFactsWeb();
  const seeded = await seedThreeParts(web, "Fact Conflict");
  const made = await seeded.api.createFact(seeded.storyId, { name: "Mara", tag: "people", text: "Mara keeps the light." });
  const factId = made.facts[0]!.id;
  const page = await openStory(web, seeded.storyId, "Fact Conflict");

  await page.keyboard.press("f");
  await waitForCount(rows(page), 1);
  await page.keyboard.press("Enter");
  const body = editor(page).getByRole("textbox", { name: "Text" });
  await body.waitFor();
  await body.fill("Mara keeps the light for years.");

  await seeded.api.patchFact(seeded.storyId, factId, { tag: "rules", text: "Mara left." });
  await editor(page).getByRole("button", { name: "Save" }).click();
  await page.getByText("This fact changed in another window. Save again to overwrite.").first().waitFor();
  expect(await body.inputValue()).toBe("Mara keeps the light for years.");
  // The tag the other window set shows; nothing else was typed over it.
  expect(await editor(page).getByRole("combobox", { name: "Tag" }).inputValue()).toBe("rules");
  expect((await seeded.api.loadStory(seeded.storyId)).facts[0]!.states[0]).toMatchObject({ text: "Mara left." });

  await editor(page).getByRole("button", { name: "Save" }).click();
  await waitForCount(editor(page), 0);
  const fact = (await seeded.api.loadStory(seeded.storyId)).facts[0]!;
  expect(fact.states[0]).toMatchObject({ text: "Mara keeps the light for years." });
  expect(fact.tag).toBe("rules");
}, 60_000);
