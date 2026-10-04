import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import type { StoryApi } from "../../client/api.js";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
import { ASIDE_LOCKED_TOAST, STORY_LOCKED_TOAST } from "../../web/src/app/run-lock.js";
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
 * Aside in a real browser (#409 step 10d), against the dry-run provider sped
 * up by `AI_1667_DRY_RUN_WORD_DELAY_MS`. Every case checks what the server
 * saved (`getAsideV2`), not only what is on screen. The forked story's part 2
 * (`B1`) has three takes, so an anchor can be told from its sibling takes.
 * Step 10e adds the Use menu: copy, compose, story (placement) and Fact.
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

async function spawnAsideWeb(project: ScratchProject, wordDelayMs: number): Promise<ReadyWeb> {
  return await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, [DRY_RUN_WORD_DELAY_VARIABLE]: String(wordDelayMs) }
  );
}

async function poll(check: () => Promise<boolean>, timeoutMs = 6_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeoutMs) return await check();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForCount(locator: Locator, count: number, timeoutMs = 6_000): Promise<void> {
  expect(await poll(async () => (await locator.count()) === count, timeoutMs)).toBeTrue();
}

function part(page: Page, text: string): Locator {
  return page.locator(".part").filter({ hasText: text });
}

function panel(page: Page): Locator {
  return page.getByRole("complementary", { name: "Aside" });
}

function questionBox(page: Page): Locator {
  return panel(page).getByRole("textbox", { name: /^(Ask a question|Retake question)$/ });
}

/** The saved turns on screen, not the answer being written. */
function turns(page: Page): Locator {
  return panel(page).locator(".aside-turn:not(.aside-live)");
}

async function openStoryPage(page: Page, web: ReadyWeb, storyId: string): Promise<void> {
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
}

/** Opens the forked story and focuses part 2 (`B1`). */
async function openForked(web: ReadyWeb, api: StoryApi): Promise<{ page: Page; storyId: string; b1: string }> {
  const seeded = await seedForkedStory(api);
  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();
  await part(page, "B1:").click();
  await part(page, "B1:").and(page.locator("[aria-current='true']")).waitFor();
  return { page, storyId: seeded.storyId, b1: seeded.b1 };
}

async function ask(page: Page, question: string): Promise<void> {
  await questionBox(page).fill(question);
  await questionBox(page).press("Enter");
}

async function savedTurns(api: StoryApi, storyId: string, takeId: string): Promise<readonly { q: string; a: string }[]> {
  const read = await api.getAsideV2!({ storyId, anchor: { partId: takeId, takeId } });
  return read?.sessions.flatMap((session) => session.turns) ?? [];
}

test("case 1: a on part 2, ask - the answer streams and lands, the server "
  + "has the turn on that take, and part 2 shows the marker", async () => {
  const project = await scratchProject();
  const web = await spawnAsideWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const { page, storyId, b1 } = await openForked(web, api);
  const diagnostics = await collectPageDiagnostics(page);

  await page.keyboard.press("a");
  await panel(page).getByRole("heading", { name: "Part 2 · take 1/3" }).waitFor();
  await ask(page, "Who is the narrator?");
  await waitForCount(turns(page), 1, 10_000);
  await panel(page).getByText("Aside (dry-run).").waitFor();

  const saved = await savedTurns(api, storyId, b1);
  expect(saved.map((turn) => turn.q)).toEqual(["Who is the narrator?"]);
  expect(saved[0]!.a).toContain("Aside (dry-run).");

  await part(page, "B1:").getByRole("button", { name: "1 aside here (a)" }).waitFor();
  await waitForCount(part(page, "A1:").getByRole("button", { name: /aside/ }), 0);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 40_000);

test("case 2: Esc before the answer starts - nothing is saved and the "
  + "question is back in the box", async () => {
  const project = await scratchProject();
  const web = await spawnAsideWeb(project, 80);
  const api = await openInspectionApi(web);
  const { page, storyId, b1 } = await openForked(web, api);

  await page.keyboard.press("a");
  await ask(page, "A question to stop");
  await panel(page).getByText("Thinking…").waitFor();
  await page.keyboard.press("Escape");

  await waitForCount(panel(page).getByRole("button", { name: "Stop" }), 0, 8_000);
  expect(await questionBox(page).inputValue()).toBe("A question to stop");
  await waitForCount(turns(page), 0);
  expect(await savedTurns(api, storyId, b1)).toEqual([]);
}, 40_000);

test("case 3: Esc mid-answer keeps the partial answer as a turn", async () => {
  const project = await scratchProject();
  const web = await spawnAsideWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const { page, storyId, b1 } = await openForked(web, api);

  await page.keyboard.press("a");
  await ask(page, "Say something long");
  await panel(page).getByText("Aside (dry-run)").waitFor();
  await page.keyboard.press("Escape");

  await waitForCount(turns(page), 1, 8_000);
  const saved = await savedTurns(api, storyId, b1);
  expect(saved.length).toBe(1);
  expect(saved[0]!.q).toBe("Say something long");
  expect(saved[0]!.a.length).toBeGreaterThan(0);
  expect(await questionBox(page).inputValue()).toBe("");
}, 40_000);

test("case 4: retake replaces the last answer, delete removes a turn, and "
  + "clear (after confirm) empties the session", async () => {
  const project = await scratchProject();
  const web = await spawnAsideWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const { page, storyId, b1 } = await openForked(web, api);

  await page.keyboard.press("a");
  await ask(page, "First question");
  await waitForCount(turns(page), 1, 10_000);

  // Retake with an edited question: the one turn is replaced, not added.
  await panel(page).getByRole("button", { name: "Edit question" }).click();
  expect(await questionBox(page).inputValue()).toBe("First question");
  await questionBox(page).fill("Edited question");
  await questionBox(page).press("Enter");
  await panel(page).locator(".aside-q", { hasText: "Edited question" }).waitFor();
  await waitForCount(turns(page), 1, 10_000);
  expect((await savedTurns(api, storyId, b1)).map((turn) => turn.q)).toEqual(["Edited question"]);

  // A plain retake keeps the question.
  await panel(page).getByRole("button", { name: "Retake" }).click();
  await waitForCount(panel(page).getByRole("button", { name: "Stop" }), 0, 10_000);
  expect((await savedTurns(api, storyId, b1)).map((turn) => turn.q)).toEqual(["Edited question"]);

  await ask(page, "Second question");
  await waitForCount(turns(page), 2, 10_000);

  await panel(page).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete turn 2" }).getByRole("button", { name: "Delete" }).click();
  await waitForCount(turns(page), 1);
  expect((await savedTurns(api, storyId, b1)).map((turn) => turn.q)).toEqual(["Edited question"]);

  await panel(page).getByRole("button", { name: "Clear this session" }).click();
  await page.getByRole("dialog", { name: "Clear this session" }).getByRole("button", { name: "Clear" }).click();
  await waitForCount(turns(page), 0);
  expect(await savedTurns(api, storyId, b1)).toEqual([]);
}, 60_000);

test("case 5: while Aside streams, Space is refused with the locked toast; "
  + "while a take streams, a question is refused and kept", async () => {
  const project = await scratchProject();
  const web = await spawnAsideWeb(project, 80);
  const api = await openInspectionApi(web);
  const { page, storyId, b1 } = await openForked(web, api);

  await page.keyboard.press("a");
  await ask(page, "A slow question");
  await panel(page).getByText("Thinking…").waitFor();
  await part(page, "C1:").click();
  await page.keyboard.press("Space");
  await page.getByText(ASIDE_LOCKED_TOAST).first().waitFor();
  await page.keyboard.press("Escape");
  await waitForCount(panel(page).getByRole("button", { name: "Stop" }), 0, 10_000);
  expect(await questionBox(page).inputValue()).toBe("A slow question");

  // The other way round: a take is running, so Aside refuses and keeps the box.
  await part(page, "C1:").click();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Stop" }).first().waitFor();
  await questionBox(page).press("Enter");
  await page.getByText(STORY_LOCKED_TOAST).first().waitFor();
  expect(await questionBox(page).inputValue()).toBe("A slow question");
  await page.keyboard.press("Escape");
  expect(await savedTurns(api, storyId, b1)).toEqual([]);
}, 60_000);

test("case 6: another take of part 2 has no sessions; back on the first "
  + "take they show again", async () => {
  const project = await scratchProject();
  const web = await spawnAsideWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const { page } = await openForked(web, api);

  await page.keyboard.press("a");
  await ask(page, "Question on take one");
  await waitForCount(turns(page), 1, 10_000);

  await part(page, "B1:").click();
  await page.keyboard.press("ArrowRight");
  await part(page, "B2:").waitFor();
  await part(page, "B2:").click();
  await page.keyboard.press("a");
  await panel(page).getByRole("heading", { name: "Part 2 · take 2/3" }).waitFor();
  await panel(page).getByText("No questions about this take yet.").waitFor();
  await waitForCount(turns(page), 0);
  // The first take's sessions are one hop away.
  await panel(page).getByRole("group", { name: "Asides elsewhere" }).waitFor();

  await part(page, "B2:").click();
  await page.keyboard.press("ArrowLeft");
  await part(page, "B1:").waitFor();
  await part(page, "B1:").click();
  await page.keyboard.press("a");
  await panel(page).getByRole("heading", { name: "Part 2 · take 1/3" }).waitFor();
  await waitForCount(turns(page), 1);
  await panel(page).locator(".aside-q", { hasText: "Question on take one" }).waitFor();
}, 60_000);

test("case 7: an edited retake question stays with its own session", async () => {
  const project = await scratchProject();
  const web = await spawnAsideWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const { page } = await openForked(web, api);

  await page.keyboard.press("a");
  await ask(page, "Question A");
  await waitForCount(turns(page), 1, 10_000);
  await panel(page).getByRole("button", { name: "Edit question" }).click();
  await questionBox(page).fill("Edit in A");

  // A second session, with its own edit.
  await panel(page).getByRole("button", { name: "New session (n)" }).click();
  await waitForCount(turns(page), 0);
  await ask(page, "Question B");
  await waitForCount(turns(page), 1, 10_000);
  await panel(page).getByRole("button", { name: "Edit question" }).click();
  await questionBox(page).fill("Edit in B");

  await panel(page).getByRole("button", { name: "Previous session (←)" }).click();
  await panel(page).locator(".aside-q", { hasText: "Question A" }).waitFor();
  expect(await questionBox(page).inputValue()).toBe("Edit in A");
  await panel(page).getByRole("button", { name: "Next session (→)" }).click();
  expect(await questionBox(page).inputValue()).toBe("Edit in B");
}, 60_000);

test("case 8: a retake edit follows its answer when an earlier turn is deleted", async () => {
  const project = await scratchProject();
  const web = await spawnAsideWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const { page, storyId, b1 } = await openForked(web, api);

  await page.keyboard.press("a");
  await ask(page, "First question");
  await waitForCount(turns(page), 1, 10_000);
  await ask(page, "Second question");
  await waitForCount(turns(page), 2, 10_000);
  await panel(page).getByRole("button", { name: "Edit question" }).click();
  await questionBox(page).fill("Second, edited");

  // Delete the first turn: the edit now belongs to turn 1, not turn 2.
  await turns(page).first().click();
  await panel(page).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete turn 1" }).getByRole("button", { name: "Delete" }).click();
  await waitForCount(turns(page), 1);
  expect(await questionBox(page).inputValue()).toBe("Second, edited");

  await questionBox(page).press("Enter");
  expect(await poll(async () => (await savedTurns(api, storyId, b1)).map((turn) => turn.q).join("|") === "Second, edited", 10_000)).toBeTrue();
}, 60_000);

/** Asks one question on part 2 and opens the Use menu of its answer. Returns the saved answer. */
async function askAndUse(page: Page, api: StoryApi, storyId: string, b1: string, item: string): Promise<string> {
  await page.keyboard.press("a");
  await ask(page, "What should happen next?");
  await waitForCount(turns(page), 1, 10_000);
  const saved = await savedTurns(api, storyId, b1);
  await panel(page).getByRole("button", { name: "Use" }).click();
  await page.getByRole("menuitem", { name: item }).click();
  return saved[0]!.a;
}

test("case 9: Insert into compose puts the answer at the composer caret", async () => {
  const project = await scratchProject();
  const web = await spawnAsideWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const { page, storyId, b1 } = await openForked(web, api);

  const composer = page.getByRole("textbox", { name: "What happens next?" });
  await composer.fill("Start End");
  await composer.press("Home");
  for (let step = 0; step < 6; step += 1) await composer.press("ArrowRight");
  await part(page, "B1:").click();
  const answer = await askAndUse(page, api, storyId, b1, "Insert into compose");

  expect(await composer.inputValue()).toBe(`Start ${answer}End`);
}, 60_000);

test("case 10: Insert into story after part 2 adds a take that becomes part 3, "
  + "with 2 takes", async () => {
  const project = await scratchProject();
  const web = await spawnAsideWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const { page, storyId, b1 } = await openForked(web, api);

  const answer = await askAndUse(page, api, storyId, b1, "Insert into story…");
  await page.getByRole("region", { name: "Insert the Aside answer" }).waitFor();
  // The choice starts on part 2; one step down is the place after it.
  await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: /^Insert here new take of part 3/ }).and(page.locator("[aria-pressed='true']")).waitFor();
  await page.keyboard.press("Enter");

  await page.getByRole("region", { name: "Insert the Aside answer" }).waitFor({ state: "detached" });
  const placed = await api.loadStory(storyId);
  expect(placed.path.length).toBe(3);
  const leaf = placed.path[2]!;
  expect(leaf.parentId).toBe(b1);
  expect(leaf.text).toBe(answer.trim());
  expect(leaf.instruction).toBe("» from aside");
  const third = page.locator(".part").nth(2);
  await third.getByRole("button", { name: /^Take 2 of 2, show every take$/ }).waitFor();
}, 60_000);

test("case 11: Insert as new Fact opens the Fact editor with the answer; Save creates it", async () => {
  const project = await scratchProject();
  const web = await spawnAsideWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const { page, storyId, b1 } = await openForked(web, api);

  const answer = await askAndUse(page, api, storyId, b1, "Insert as new Fact");
  const editor = page.getByRole("form", { name: "New fact" });
  await editor.waitFor();
  expect(await editor.getByRole("textbox", { name: "Text" }).inputValue()).toBe(answer);
  await editor.getByRole("button", { name: "Save" }).click();

  expect(await poll(async () => (await api.loadStory(storyId)).facts.length === 1)).toBeTrue();
  expect((await api.loadStory(storyId)).facts[0]!.states[0]).toMatchObject({ text: answer.trim() });
}, 60_000);

test("case 12: Esc during placement leaves the story unchanged", async () => {
  const project = await scratchProject();
  const web = await spawnAsideWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const { page, storyId, b1 } = await openForked(web, api);
  const before = await api.loadStory(storyId);

  await askAndUse(page, api, storyId, b1, "Insert into story…");
  await page.getByRole("region", { name: "Insert the Aside answer" }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");

  await page.getByRole("region", { name: "Insert the Aside answer" }).waitFor({ state: "detached" });
  const after = await api.loadStory(storyId);
  expect(after.nodes.length).toBe(before.nodes.length);
  expect(after.path.map((node) => node.id)).toEqual(before.path.map((node) => node.id));
  await waitForCount(turns(page), 1);
}, 60_000);
