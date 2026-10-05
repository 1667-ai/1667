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
 * Inline editing in a real browser (#409 step 6): `e` (Save as new take,
 * Save in place), `w`, the part menu, and delete. Every case checks the SAVED
 * story through a second connection, not only what is on screen.
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

async function spawnEditWeb(wordDelayMs = 20): Promise<ReadyWeb> {
  const project = await scratchProject();
  return await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, [DRY_RUN_WORD_DELAY_VARIABLE]: String(wordDelayMs) }
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

async function isFocused(locator: Locator): Promise<boolean> {
  return await locator.evaluate((element) => element === document.activeElement);
}

/** Saves a screenshot as `web-compose-<name>.png` into the directory named by
 * `AI_1667_WEB_UI_SCREENSHOTS`; does nothing when it is not set. */
async function screenshot(page: Page, name: string): Promise<void> {
  const dir = process.env.AI_1667_WEB_UI_SCREENSHOTS;
  // Let the entrance animations finish first.
  if (dir !== undefined) await page.waitForTimeout(500);
  if (dir !== undefined) await page.screenshot({ path: `${dir}/web-compose-${name}.png` });
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

async function openStory(web: ReadyWeb, storyId: string, title: string): Promise<Page> {
  const page = await openTestPage(await sharedBrowser());
  await page.goto(web.url);
  await page.getByRole("button", { name: "New story" }).waitFor();
  await page.evaluate((id) => { location.hash = `#/story/${id}`; }, storyId);
  await page.getByRole("heading", { name: title }).waitFor();
  return page;
}

function editorProse(page: Page, partNumber: number): Locator {
  return page.getByRole("textbox", { name: `Text of part ${partNumber}` });
}

test("case 1: e then Save in place keeps the take count and marks the part as a human edit", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Edit In Place");
  const page = await openStory(web, seeded.storyId, "Edit In Place");
  const diagnostics = await collectPageDiagnostics(page);
  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");

  await page.keyboard.press("e");
  expect(await poll(() => isFocused(editorProse(page, 2)))).toBeTrue();
  expect(await editorProse(page, 2).inputValue()).toBe("B: the middle part.");
  await editorProse(page, 2).fill("B: the middle part, rewritten.");
  await screenshot(page, "editor");
  await page.getByRole("button", { name: "Save in place" }).click();

  await waitForCount(page.getByRole("textbox", { name: "Text of part 2" }), 0);
  await waitForCount(part(page, "B: the middle part, rewritten."), 1);
  expect(await part(page, "rewritten").locator(".part-badge").allTextContents()).toContain("human edit");
  expect(await part(page, "rewritten").getByRole("button", { name: /show every take/ }).count()).toBe(0);
  expect(await poll(() => isFocused(part(page, "rewritten")))).toBeTrue();

  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.path[1]!.id).toBe(seeded.b);
  expect(saved.path[1]!.text).toBe("B: the middle part, rewritten.");
  expect(saved.nodes).toHaveLength(3);
  await page.waitForTimeout(300);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 60_000);

test("case 2: Ctrl/Cmd+S saves as a new take and keeps the original", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Edit As New Take");
  const page = await openStory(web, seeded.storyId, "Edit As New Take");
  await part(page, "B:").click();

  await page.keyboard.press("e");
  await editorProse(page, 2).fill("B: another way to put it.");
  await page.keyboard.press("ControlOrMeta+s");

  await waitForCount(part(page, "B: another way to put it."), 1);
  await waitForCount(part(page, "another way").getByRole("button", { name: /^Take \d+ of 2, show every take$/ }), 1);

  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.path[1]!.text).toBe("B: another way to put it.");
  const original = await seeded.api.loadStory(seeded.storyId);
  expect(original.nodes.filter((node) => node.parentId === seeded.a)).toHaveLength(2);
  expect(original.nodes.some((node) => node.id === seeded.b)).toBeTrue();
}, 60_000);

test("case 3: a change made elsewhere shows a toast, keeps the typed text, and the next save overwrites", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Edit Conflict");
  const page = await openStory(web, seeded.storyId, "Edit Conflict");
  await part(page, "B:").click();

  await page.keyboard.press("e");
  await editorProse(page, 2).fill("B: my version.");
  const current = await seeded.api.loadStory(seeded.storyId);
  await seeded.api.editNode(seeded.storyId, current.path[1]!, { text: "B: changed from elsewhere." });

  await page.getByRole("button", { name: "Save in place" }).click();
  await page.getByText("Save again to overwrite.").first().waitFor();
  expect(await editorProse(page, 2).inputValue()).toBe("B: my version.");

  await page.getByRole("button", { name: "Save in place" }).click();
  // The open editor already holds the typed text: wait for it to close.
  await waitForCount(editorProse(page, 2), 0);
  await waitForCount(part(page, "B: my version."), 1);
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.path[1]!.text).toBe("B: my version.");
}, 60_000);

test("case 4: Escape closes a clean editor, a changed one needs a second Escape, and neither stops a background run", async () => {
  const web = await spawnEditWeb(60);
  const seeded = await seedThreeParts(web, "Edit Escape");
  const page = await openStory(web, seeded.storyId, "Edit Escape");
  await part(page, "A:").click();

  await page.keyboard.press("e");
  await editorProse(page, 1).waitFor();
  await page.keyboard.press("Escape");
  await waitForCount(editorProse(page, 1), 0);

  // Start a run on the leaf, then open an editor on an earlier part.
  await part(page, "C:").click();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Stop" }).waitFor();
  await part(page, "A:").click();
  await page.keyboard.press("e");
  await editorProse(page, 1).fill("A: changed.");
  await page.keyboard.press("Escape");
  await page.getByText("Esc again discards your changes.").waitFor();
  expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(1);
  await page.keyboard.press("Escape");
  await waitForCount(editorProse(page, 1), 0);
  expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(1);
  expect(await part(page, "A: the opening part.").count()).toBe(1);
}, 60_000);

test("case 5: w then Ctrl/Cmd+S writes your own take: your words, 2 takes", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Write Own Take");
  const page = await openStory(web, seeded.storyId, "Write Own Take");
  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");

  await page.keyboard.press("w");
  const box = page.getByRole("textbox", { name: "Your take of part 2" });
  expect(await poll(() => isFocused(box))).toBeTrue();
  expect(await box.inputValue()).toBe("");
  await box.fill("B: written by hand.");
  await page.keyboard.press("ControlOrMeta+s");

  await waitForCount(part(page, "B: written by hand."), 1);
  const landed = part(page, "written by hand");
  expect(await landed.locator(".part-badge").allTextContents()).toContain("your words");
  await waitForCount(landed.getByRole("button", { name: /^Take \d+ of 2, show every take$/ }), 1);
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.path[1]!.text).toBe("B: written by hand.");
  expect(saved.path[1]!.parentId).toBe(seeded.a);
  expect(saved.nodes.filter((node) => node.parentId === seeded.a)).toHaveLength(2);
}, 60_000);

test("case 6: w on an empty story writes part 1", async () => {
  const web = await spawnEditWeb();
  const api = await openInspectionApi(web);
  const created = await api.createStory("Empty Story");
  const page = await openStory(web, created.id, "Empty Story");

  await page.getByText("This story has no text yet.").waitFor();
  await page.keyboard.press("w");
  const box = page.getByRole("textbox", { name: "Your first part" });
  expect(await poll(() => isFocused(box))).toBeTrue();
  await box.fill("In the beginning.");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // The open editor is itself a part that holds the typed text, so only its
  // close shows that the save is done.
  await waitForCount(box, 0);
  await waitForCount(part(page, "In the beginning."), 1);
  const saved = await api.loadStory(created.id);
  expect(saved.path).toHaveLength(1);
  expect(saved.path[0]!.text).toBe("In the beginning.");
  expect(saved.path[0]!.parentId).toBeNull();
}, 60_000);

test("case 7: x opens the part menu; Escape closes it without stopping a background run; an item acts", async () => {
  const web = await spawnEditWeb(60);
  const seeded = await seedThreeParts(web, "Part Menu");
  const page = await openStory(web, seeded.storyId, "Part Menu");
  const diagnostics = await collectPageDiagnostics(page);
  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");

  await page.keyboard.press("x");
  const menu = page.getByRole("menu", { name: "Actions for part 2" });
  await menu.waitFor();
  const labels = await menu.getByRole("menuitem").evaluateAll(
    (items) => items.map((item) => item.querySelector("span")?.textContent ?? "")
  );
  expect(labels).toEqual(["Continue", "Direct", "Retake", "Retake with direction", "Write", "Edit", "Copy", "Copy story line below", "Tag line", "End chapter here", "Delete", "Fact from here", "New fact state", "End fact here", "New fact"]);
  await screenshot(page, "menu");
  await page.keyboard.press("Escape");
  await waitForCount(menu, 0);

  // A run on the leaf keeps going through a menu's Escape, and the menu's
  // changing items wait while it writes.
  await part(page, "C:").click();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Stop" }).waitFor();
  await part(page, "B:").getByRole("button", { name: "Part actions (x)" }).click();
  await menu.waitFor();
  expect(await menu.getByRole("menuitem", { name: /^Retake\b(?! with)/ }).isDisabled()).toBeTrue();
  expect(await menu.getByRole("menuitem", { name: /^Delete/ }).isDisabled()).toBeTrue();
  expect(await menu.getByRole("menuitem", { name: /^Edit/ }).isDisabled()).toBeFalse();
  await page.keyboard.press("Escape");
  await waitForCount(menu, 0);
  expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(1);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Continue" }).waitFor();
  await part(page, "B:").click();
  await part(page, "B:").getByRole("button", { name: "Part actions (x)" }).click();
  await menu.getByRole("menuitem", { name: /^Edit/ }).click();
  await editorProse(page, 2).waitFor();
  expect(await poll(() => isFocused(editorProse(page, 2)))).toBeTrue();
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 90_000);

test("case 8: D asks first; Cancel keeps everything; confirming deletes the part and what is below it", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Delete Part");
  const page = await openStory(web, seeded.storyId, "Delete Part");
  await part(page, "B:").click();
  await waitForAttribute(part(page, "B:"), "aria-current", "true");

  await page.keyboard.press("Shift+D");
  const dialog = page.getByRole("dialog", { name: "Delete part" });
  await dialog.waitFor();
  expect(await dialog.textContent()).toContain("Delete part 2 and the 1 part below it?");
  await screenshot(page, "delete");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await waitForCount(dialog, 0);
  expect((await seeded.api.loadStory(seeded.storyId)).path).toHaveLength(3);

  await page.keyboard.press("Shift+D");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await waitForCount(dialog, 0);
  await waitForCount(page.locator(".part"), 1);
  expect(await poll(() => isFocused(part(page, "A:")))).toBeTrue();
  const saved = await seeded.api.loadStory(seeded.storyId);
  expect(saved.path).toHaveLength(1);
  expect(saved.nodes).toHaveLength(1);
}, 60_000);

test("case 9: when another window deletes the part being edited, the text stays reachable with Copy and Discard", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Edit Recovery");
  const page = await openStory(web, seeded.storyId, "Edit Recovery");
  await part(page, "B:").click();

  await page.keyboard.press("e");
  await editorProse(page, 2).fill("B: my words, kept.");
  await seeded.api.deleteNode(seeded.storyId, seeded.b, 2);

  await page.getByRole("button", { name: "Save in place" }).click();
  const recovery = page.getByRole("region", { name: "Editor without a part" });
  await recovery.waitFor();
  expect(await recovery.getByRole("textbox", { name: "Your unsaved text" }).inputValue()).toBe("B: my words, kept.");
  await recovery.getByRole("button", { name: "Copy" }).waitFor();
  await recovery.getByRole("button", { name: "Discard" }).click();
  await waitForCount(recovery, 0);
}, 60_000);

test("case 10: with a changed editor on part 2, Space on part 1 is refused and the draft stays", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Edit Lock");
  const page = await openStory(web, seeded.storyId, "Edit Lock");
  await part(page, "B:").click();
  await page.keyboard.press("e");
  await editorProse(page, 2).fill("B: changed, not saved.");
  await part(page, "A:").click();
  await waitForAttribute(part(page, "A:"), "aria-current", "true");
  await page.keyboard.press("Space");

  await page.getByText("Finish or cancel the open editor first.").first().waitFor();
  expect(await editorProse(page, 2).inputValue()).toBe("B: changed, not saved.");
  expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(0);
}, 60_000);

test("case 11: clicking back into an open editor's text keeps the keyboard there", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Editor Focus");
  const page = await openStory(web, seeded.storyId, "Editor Focus");
  await part(page, "B:").click();
  await page.keyboard.press("e");
  await editorProse(page, 2).fill("B: ");

  await part(page, "A:").click();
  await waitForAttribute(part(page, "A:"), "aria-current", "true");
  await editorProse(page, 2).click();
  expect(await poll(() => isFocused(editorProse(page, 2)))).toBeTrue();
  await page.keyboard.type("pwe typed after the click");

  expect(await editorProse(page, 2).inputValue()).toContain("pwe typed after the click");
  expect(await isFocused(editorProse(page, 2))).toBeTrue();
}, 60_000);

test("case 12: the recovery view shows the edited direction too", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Recovery Direction");
  const page = await openStory(web, seeded.storyId, "Recovery Direction");
  await page.getByRole("button", { name: "Show directions" }).click();
  await part(page, "B:").click();
  await page.keyboard.press("e");
  await page.getByRole("textbox", { name: "Direction" }).fill("Go far left.");
  await editorProse(page, 2).fill("B: my words, kept.");
  await seeded.api.deleteNode(seeded.storyId, seeded.b, 2);

  await page.getByRole("button", { name: "Save in place" }).click();
  const recovery = page.getByRole("region", { name: "Editor without a part" });
  await recovery.waitFor();

  expect(await recovery.getByRole("textbox", { name: "Your unsaved direction" }).inputValue()).toBe("Go far left.");
  expect(await recovery.getByRole("textbox", { name: "Your unsaved text" }).inputValue()).toBe("B: my words, kept.");
}, 60_000);

test("case 13: unsent composer text and a changed editor warn before a reload and stay reachable when the connection is gone", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Unsaved Work");
  const page = await openStory(web, seeded.storyId, "Unsaved Work");
  await part(page, "C:").click();
  await page.keyboard.press("i");
  await page.getByRole("textbox", { name: "What happens next?" }).fill("An unsent direction.");
  await page.keyboard.press("Escape");

  web.child.kill("SIGKILL");
  await web.exit;
  const work = page.getByRole("region", { name: "Unsaved work" });
  await work.waitFor({ timeout: 10_000 });
  expect(await work.getByRole("textbox", { name: "Unsent direction" }).inputValue()).toBe("An unsent direction.");
  await work.getByRole("button", { name: "Copy" }).waitFor();

  let sawBeforeUnload = false;
  page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") sawBeforeUnload = true;
    void dialog.accept();
  });
  await page.reload().catch(() => {});
  expect(sawBeforeUnload).toBeTrue();
}, 60_000);

test("case 14: unsent composer text alone warns before a reload", async () => {
  const web = await spawnEditWeb();
  const seeded = await seedThreeParts(web, "Composer Unload");
  const page = await openStory(web, seeded.storyId, "Composer Unload");
  await part(page, "C:").click();
  await page.keyboard.press("i");
  await page.getByRole("textbox", { name: "What happens next?" }).fill("An unsent direction.");

  let sawBeforeUnload = false;
  page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") sawBeforeUnload = true;
    void dialog.accept();
  });
  await page.reload();

  expect(sawBeforeUnload).toBeTrue();
}, 60_000);

test("case 15: a changed first-part editor refuses Continue, and its text stays reachable when another window writes part 1", async () => {
  const web = await spawnEditWeb();
  const api = await openInspectionApi(web);
  const created = await api.createStory("First Part Guard");
  const page = await openStory(web, created.id, "First Part Guard");

  await page.keyboard.press("w");
  const box = page.getByRole("textbox", { name: "Your first part" });
  expect(await poll(() => isFocused(box))).toBeTrue();
  await box.fill("My first part, not saved yet.");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Finish or cancel the open editor first.").first().waitFor();
  expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(0);
  expect(await box.inputValue()).toBe("My first part, not saved yet.");

  // Another window writes part 1; this window's Save then finds a story it
  // did not expect, and the text must stay reachable.
  await api.createNode(created.id, { text: "Written elsewhere.", parentId: null });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const recovery = page.getByRole("region", { name: "Editor without a part" });
  await recovery.waitFor();
  expect(await recovery.getByRole("textbox", { name: "Your unsaved text" }).inputValue()).toBe("My first part, not saved yet.");
}, 60_000);
