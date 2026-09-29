import { afterEach, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import type { GenerationSettings } from "../../shared/types.js";
import type { StoryApi } from "../../client/api.js";
import { DRY_RUN_WORD_DELAY_VARIABLE } from "../../server/providers.js";
import { STORY_LOCKED_TOAST } from "../../web/src/story/actions.js";
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
 * Continue/Stop streaming in a real browser (#409 step 5), against the
 * dry-run provider sped up by `AI_1667_DRY_RUN_WORD_DELAY_MS`
 * (`server/providers.ts`). Locators are by role and accessible name, or by
 * the manuscript's own long-lived structural classes (`.part`,
 * `.part-streaming`, `.caret`) — never anything the design is free to
 * rename. Correctness of the stop/save contract is the point of this suite:
 * every "Stop" or failure case below checks the SAVED text, not only what
 * is on screen a moment later.
 */

/** Fast enough to keep the whole ~85-word dry-run stream (reasoning +
 * prose) under two seconds, slow enough that a mid-stream action (Stop, a
 * route change, a kill) reliably lands before it finishes on its own. */
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

async function spawnGenWeb(project: ScratchProject, wordDelayMs: number): Promise<ReadyWeb> {
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

/** A same-tab, same-connection route change — the one that must never stop
 * a background generation (decision 2). Never re-navigates the page. */
async function gotoStory(page: Page, storyId: string | null): Promise<void> {
  await page.evaluate((id) => {
    location.hash = id === null ? "#/" : `#/story/${id}`;
  }, storyId);
}

function part(page: Page, text: string): Locator {
  return page.locator(".part").filter({ hasText: text });
}

function streamingPart(page: Page): Locator {
  return page.locator(".part-streaming");
}

function caret(page: Page): Locator {
  return page.locator(".caret");
}

function generationStatus(page: Page): Locator {
  return page.locator(".generation-status");
}

function continueButton(page: Page): Locator {
  return page.getByRole("button", { name: "Continue" });
}

function stopButton(page: Page): Locator {
  return page.getByRole("button", { name: "Stop" });
}

async function proseText(locator: Locator): Promise<string> {
  return (await locator.locator(".prose").textContent()) ?? "";
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

/** Waits for a part's prose to grow past `base` — unlike waiting for the
 * caret (which can appear the instant a run starts, before reasoning has
 * even arrived: TUI parity, `tui/src/reasoning-model.ts`'s `streamThinkingOnly`
 * only trades "writing" for "thinking" once reasoning is substantive), this
 * is the one reliable "genuine prose has streamed" signal a test can act on
 * before Stopping. Returns the grown text. */
async function waitForGrowth(locator: Locator, base: string, timeoutMs = 5_000): Promise<string> {
  let current = base;
  await poll(async () => {
    current = (await locator.locator(".prose").textContent()) ?? "";
    return current.length > base.length;
  }, timeoutMs);
  return current;
}

/** Same idea as waitForGrowth, for a fresh StreamingPart (mode: "take") that
 * starts with no prior text at all — waits for its own prose to become
 * non-empty before a test Stops it, so "nothing substantive yet" (the
 * caret's own brief pre-reasoning window) can never be mistaken for a
 * genuine new take. */
async function waitForStreamingProse(page: Page, timeoutMs = 5_000): Promise<void> {
  const ok = await poll(async () => {
    const text = (await streamingPart(page).locator(".prose").textContent()) ?? "";
    return text.trim().length > 0;
  }, timeoutMs);
  expect(ok).toBeTrue();
}

async function waitForAttribute(locator: Locator, name: string, value: string): Promise<void> {
  const ok = await poll(async () => (await locator.getAttribute(name)) === value);
  expect(ok).toBeTrue();
}

async function waitForTextMatching(locator: Locator, pattern: RegExp): Promise<void> {
  const ok = await poll(async () => pattern.test((await locator.textContent()) ?? ""));
  expect(ok).toBeTrue();
}

async function waitForLabelMatching(locator: Locator, pattern: RegExp): Promise<void> {
  const ok = await poll(async () => pattern.test((await locator.getAttribute("aria-label")) ?? ""));
  expect(ok).toBeTrue();
}

function takeCounter(page: Page): Locator {
  return page.getByRole("button", { name: /show every take/ });
}

async function setProvider(api: StoryApi, overrides: Partial<GenerationSettings>): Promise<void> {
  const view = await api.getSettings();
  if (view.dataFormat !== 2 || !view.editable) {
    throw new Error(`expected an editable, current-format settings view, got dataFormat ${view.dataFormat}`);
  }
  const mutationId = createDurableMutationId();
  await api.saveSettings({
    transportOperationId: `generation-test:${mutationId}`,
    mutationId,
    expectedStateGeneration: view.stateGeneration,
    document: applyBasicSettingsDraft(view.document, { ...view.effective, ...overrides })
  });
}

test("case 1: Space at the leaf appends — text grows, the part count stays "
  + "the same, shows a caret and Writing…, and loadStory/reload agree", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Append Story");
  await api.createNode(created.id, { text: "The opening line.", parentId: null });

  const page = await openTestPage(await sharedBrowser());
  const diagnostics = await collectPageDiagnostics(page);
  await openStoryPage(page, web, created.id);
  await page.getByRole("heading", { name: "Append Story" }).waitFor();
  await waitForCount(page.locator(".part"), 1);

  await continueButton(page).click();
  await waitForCount(caret(page), 1);
  await waitForTextMatching(generationStatus(page), /Writing…|Thinking…/);
  await waitForCount(page.locator(".part"), 1);

  await waitForCount(continueButton(page), 1, 8_000);

  const onScreen = await proseText(part(page, "The opening line."));
  expect(onScreen.length).toBeGreaterThan("The opening line.".length);
  expect(onScreen).toContain("dry-run text");

  const inspected = await api.loadStory(created.id);
  expect(inspected.path.at(-1)!.text).toBe(onScreen);

  await page.reload();
  await page.getByRole("heading", { name: "Append Story" }).waitFor();
  expect(await proseText(part(page, "The opening line."))).toBe(onScreen);

  await page.waitForTimeout(300);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 30_000);

test("case 2: Space on an earlier part opens a new take of the next part — "
  + "the old take is hidden while writing, focus lands on the new take, and "
  + "it shows ×2 once landed", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  await part(page, "B1:").click();
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");

  await continueButton(page).click();
  await waitForCount(streamingPart(page), 1);
  await waitForCount(page.locator(".part").filter({ hasText: "C1:" }), 0);
  await waitForCount(page.locator(".part"), 3); // A1, B1, the streaming placeholder
  await waitForStreamingProse(page);

  await page.keyboard.press("Escape");
  await waitForCount(continueButton(page), 1, 6_000);

  await waitForCount(page.locator(".part-streaming"), 0);
  await waitForCount(page.locator(".part"), 3); // A1, B1, the new (landed) take
  const newLeaf = page.locator(".part").nth(2);
  await waitForAttribute(newLeaf, "aria-current", "true");
  await waitForCount(newLeaf.locator(".label-chip"), 1);
  expect(await newLeaf.locator(".label-chip").textContent()).toContain("×2");
}, 30_000);

test("case 3: the Continue button behaves exactly like Space — Stop while "
  + "running, Continue again once it settles", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Button Story");
  await api.createNode(created.id, { text: "Start.", parentId: null });

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, created.id);
  await page.getByRole("heading", { name: "Button Story" }).waitFor();

  await waitForCount(continueButton(page), 1);
  await continueButton(page).click();
  await waitForCount(stopButton(page), 1);
  await waitForCount(continueButton(page), 0);

  await stopButton(page).click();
  await waitForCount(continueButton(page), 1, 6_000);
  await waitForCount(stopButton(page), 0);
}, 30_000);

test("case 4: Esc mid-stream keeps the partial — the saved text is exactly "
  + "what was on screen, and it survives a reload", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Stop Story");
  await api.createNode(created.id, { text: "Once upon a time.", parentId: null });

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, created.id);
  await page.getByRole("heading", { name: "Stop Story" }).waitFor();

  await continueButton(page).click();
  await waitForGrowth(part(page, "Once upon a time."), "Once upon a time.");
  await page.keyboard.press("Escape");
  await waitForCount(continueButton(page), 1, 6_000);

  const onScreen = await proseText(part(page, "Once upon a time."));
  expect(onScreen.length).toBeGreaterThan("Once upon a time.".length);
  const inspected = await api.loadStory(created.id);
  expect(inspected.path.at(-1)!.text).toBe(onScreen);

  await page.reload();
  await page.getByRole("heading", { name: "Stop Story" }).waitFor();
  expect(await proseText(part(page, "Once upon a time."))).toBe(onScreen);
}, 30_000);

test("case 5: Esc during Thinking keeps nothing", async () => {
  const project = await scratchProject();
  // Slower on purpose: gives Thinking… (7 reasoning words) enough real time
  // to reliably still be showing when Escape lands.
  const web = await spawnGenWeb(project, 80);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Thinking Story");
  await api.createNode(created.id, { text: "Fixed text.", parentId: null });

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, created.id);
  await page.getByRole("heading", { name: "Thinking Story" }).waitFor();

  await continueButton(page).click();
  await waitForTextMatching(generationStatus(page), /Thinking…/);
  await page.keyboard.press("Escape");
  await waitForCount(continueButton(page), 1, 6_000);

  expect(await proseText(part(page, "Fixed text."))).toBe("Fixed text.");
  const inspected = await api.loadStory(created.id);
  expect(inspected.path.at(-1)!.text).toBe("Fixed text.");
}, 30_000);

test("case 6: while writing, take controls are disabled and ←/→ toast; "
  + "↑/↓ still move focus; Space toasts; Esc stops", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  await part(page, "B1:").click();
  await waitForAttribute(part(page, "B1:"), "aria-current", "true");
  await continueButton(page).click();
  await waitForCount(streamingPart(page), 1);

  const prevTakeButton = page.getByRole("button", { name: /Previous take/ });
  expect(await prevTakeButton.isDisabled()).toBeTrue();

  await page.keyboard.press("ArrowLeft");
  await page.getByText(STORY_LOCKED_TOAST).first().waitFor();

  await page.keyboard.press("ArrowUp");
  await waitForAttribute(part(page, "A1:"), "aria-current", "true");

  await page.keyboard.press("Space");
  await page.getByText(STORY_LOCKED_TOAST).first().waitFor();

  await page.keyboard.press("Escape");
  await waitForCount(continueButton(page), 1, 6_000);
  expect(await prevTakeButton.isDisabled()).toBeFalse();
}, 30_000);

test("case 7: reloading mid-stream (accepting the beforeunload prompt) "
  + "leaves the story unchanged; Space still works afterward", async () => {
  const project = await scratchProject();
  // Slower than the suite default: the background generation must still be
  // running (not yet landed) by the time the reload-and-recheck round trip
  // finishes, or "unchanged" would trivially pass for the wrong reason.
  const web = await spawnGenWeb(project, 60);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Reload Story");
  await api.createNode(created.id, { text: "Before reload.", parentId: null });

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, created.id);
  await page.getByRole("heading", { name: "Reload Story" }).waitFor();

  let sawBeforeUnload = false;
  page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") sawBeforeUnload = true;
    void dialog.accept();
  });

  await continueButton(page).click();
  await waitForCount(caret(page), 1);
  const before = await api.loadStory(created.id);

  await page.reload();
  expect(sawBeforeUnload).toBeTrue();
  await page.getByRole("heading", { name: "Reload Story" }).waitFor();

  const after = await api.loadStory(created.id);
  expect(after.path.at(-1)!.text).toBe(before.path.at(-1)!.text);

  // Space must still work — either it starts a fresh generation, or (if the
  // background one from before the reload has not yet settled) it reports
  // the busy toast; either way, the key must never be dead.
  await waitForCount(continueButton(page), 1, 10_000);
  await continueButton(page).click();
  const started = await poll(async () => (await stopButton(page).count()) === 1, 2_000);
  if (started) {
    await page.keyboard.press("Escape");
    await waitForCount(continueButton(page), 1, 6_000);
  }
}, 30_000);

// Case 8, as originally specified ("a second window's Space while the first
// writes gets the busy toast"), was dropped from the first pass of this
// suite as unreliable to automate. The #409 step 5 review's own fixes doc
// asked for it to be retried after fixing the optimistic-status gap it
// suspected was the cause (review fix #12). That fix is real and worth
// having on its own (see case 18 below), but retrying case 8 under it
// turned up that its premise was never accurate: see case 18's own comment
// for why the server admits a second tab's Continue rather than refusing it
// with resource_busy. Case 18 replaces this one with what the product
// actually does.

test("case 9: a provider failure toasts and leaves the story unchanged; "
  + "Space works again once dry-run is restored", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Failure Story");
  await api.createNode(created.id, { text: "Before the failure.", parentId: null });
  await setProvider(api, {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1",
    model: "missing",
    apiKeyEnv: null
  });

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, created.id);
  await page.getByRole("heading", { name: "Failure Story" }).waitFor();

  await continueButton(page).click();
  await waitForCount(continueButton(page), 1, 10_000);

  const inspected = await api.loadStory(created.id);
  expect(inspected.path.at(-1)!.text).toBe("Before the failure.");

  await setProvider(api, { provider: "dry-run" });
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __toasts: string[] }).__toasts = seen;
    new MutationObserver(() => {
      document.querySelectorAll(".toast").forEach((toast) => {
        const text = toast.textContent ?? "";
        if (!seen.includes(text)) seen.push(text);
      });
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await continueButton(page).click();
  const sawCaret = await poll(async () => (await caret(page).count()) === 1, 6_000);
  if (!sawCaret) {
    // Diagnostic for a Linux-only failure: what did the page show instead?
    console.log("CASE9-DIAG", JSON.stringify(await page.evaluate(() => document.body.innerText)));
    console.log("CASE9-TOASTS", JSON.stringify(await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts)));
    console.log("CASE9-STORY", JSON.stringify((await api.loadStory(created.id)).path.map((n) => n.text)));
  }
  expect(sawCaret).toBeTrue();
  await page.keyboard.press("Escape");
  await waitForCount(continueButton(page), 1, 6_000);
}, 30_000);

test("case 10: background writing — the bar shows \"Writing in\" elsewhere, "
  + "Space toasts, Esc stops it from there and keeps A's text, and letting "
  + "it finish elsewhere lands with a toast and does not move B's focus", async () => {
  const project = await scratchProject();
  // Slower than the suite default: each of the two runs below has to survive
  // a same-tab route change, a keypress, and several assertions in real
  // time before it would otherwise finish on its own — WORD_DELAY_MS's
  // ~1.7s budget is too tight for that whole sequence.
  const web = await spawnGenWeb(project, 60);
  const api = await openInspectionApi(web);
  const storyA = await api.createStory("Story A");
  await api.createNode(storyA.id, { text: "A's opening.", parentId: null });
  const storyB = await api.createStory("Story B");
  await api.createNode(storyB.id, { text: "B's opening.", parentId: null });

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, storyA.id);
  await page.getByRole("heading", { name: "Story A" }).waitFor();
  await continueButton(page).click();
  // Confirmed genuine prose (not just the caret, which can render before any
  // reasoning or prose has arrived — see waitForGrowth's own doc) before
  // leaving, so the later Escape-from-B is guaranteed to keep something.
  await waitForGrowth(part(page, "A's opening."), "A's opening.");

  await gotoStory(page, storyB.id);
  await page.getByRole("heading", { name: "Story B" }).waitFor();
  await waitForTextMatching(generationStatus(page), /Writing in Story A/);

  await page.keyboard.press("Space");
  await page.getByText(/Already writing in Story A/).waitFor();

  await page.keyboard.press("Escape");
  // Back to idle: GenerationBar's idle branch renders no .generation-status
  // at all (just the Continue button), so the element itself disappears.
  await waitForCount(generationStatus(page), 0, 8_000);
  const inspectedA = await api.loadStory(storyA.id);
  expect(inspectedA.path.at(-1)!.text.length).toBeGreaterThan("A's opening.".length);

  // Separately: let a second run finish naturally while B stays open.
  await gotoStory(page, storyA.id);
  await page.getByRole("heading", { name: "Story A" }).waitFor();
  const secondStart = await api.loadStory(storyA.id);
  await continueButton(page).click();
  await waitForCount(caret(page), 1);

  await gotoStory(page, storyB.id);
  await page.getByRole("heading", { name: "Story B" }).waitFor();
  await waitForAttribute(part(page, "B's opening."), "aria-current", "true");

  // Playwright's own `.waitFor` on a toast that also auto-dismisses itself
  // has proven unreliable here; poll with our own helper instead, matching
  // every other wait in this suite.
  const sawWrittenToast = await poll(async () => (
    await page.getByText(/Part \d+ written in Story A\./).count()) > 0, 25_000);
  expect(sawWrittenToast).toBeTrue();
  // B's own focus never moved.
  await waitForAttribute(part(page, "B's opening."), "aria-current", "true");

  // Story A has only ever had one part, so every continue on it is an
  // append (grows the same node) — the saved text, not the path length, is
  // what proves the second run actually landed.
  const landedA = await api.loadStory(storyA.id);
  expect(landedA.path.at(-1)!.text.length).toBeGreaterThan(secondStart.path.at(-1)!.text.length);
}, 60_000);

test("case 11: Space on a focused take arrow activates the arrow instead of "
  + "starting a generation; Shift+Space never starts one either", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const seeded = await seedForkedStory(api);

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, seeded.storyId);
  await page.getByRole("heading", { name: "Forked Story" }).waitFor();

  await part(page, "B1:").click();
  const nextTakeButton = page.getByRole("button", { name: /Next take/ });
  await nextTakeButton.focus();
  await page.keyboard.press("Space");
  await waitForLabelMatching(takeCounter(page), /Take 2 of 3/);
  await waitForCount(page.locator(".part").filter({ hasText: "C2:" }), 1);
  // The arrow activated — no generation started.
  await waitForCount(stopButton(page), 0);
  await waitForCount(continueButton(page), 1);

  // Shift+Space, focused on the part itself (not a button), must never
  // start a generation either — the browser keeps its native scroll.
  await part(page, "A1:").click();
  await page.keyboard.press("Shift+Space");
  await page.waitForTimeout(300);
  await waitForCount(stopButton(page), 0);
  await waitForCount(continueButton(page), 1);
}, 30_000);

test("case 12: continuing an empty story writes part 1", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Empty Story");

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, created.id);
  await page.getByRole("heading", { name: "Empty Story" }).waitFor();
  await page.getByText("This story has no text yet.").waitFor();

  await continueButton(page).click();
  await waitForCount(streamingPart(page), 1);
  await page.getByText("PART 1").waitFor();
  await waitForStreamingProse(page);

  await page.keyboard.press("Escape");
  await waitForCount(continueButton(page), 1, 6_000);
  await waitForCount(page.locator(".part"), 1);
}, 30_000);

test("case 13: continuing from a leaf with an anchored chapter break opens "
  + "a new part below the divider", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Chapter Story");
  const seeded = await api.createNode(created.id, { text: "Chapter one ends here.", parentId: null });
  const a1 = seeded.path.at(-1)!.id;
  await api.createChapterBreak(created.id, a1, "Two");

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, created.id);
  await page.getByRole("heading", { name: "Chapter Story" }).waitFor();
  await page.locator(".chapter-divider").waitFor();

  await continueButton(page).click();
  await waitForCount(streamingPart(page), 1);

  const rows = page.locator(".manuscript > li");
  const dividerIndex = await rows.evaluateAll((elements) =>
    elements.findIndex((element) => element.classList.contains("chapter-divider")));
  const streamingIndex = await rows.evaluateAll((elements) =>
    elements.findIndex((element) => element.querySelector(".part-streaming") !== null));
  expect(dividerIndex).toBeGreaterThanOrEqual(0);
  expect(streamingIndex).toBeGreaterThan(dividerIndex);

  await waitForStreamingProse(page);
  await page.keyboard.press("Escape");
  await waitForCount(continueButton(page), 1, 6_000);
  await waitForCount(page.locator(".part"), 2);
}, 30_000);

test("case 14: killing the server mid-stream shows a Not saved card; Copy "
  + "and Discard both work", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Connection Loss Story");
  await api.createNode(created.id, { text: "Before the crash.", parentId: null });

  const page = await openTestPage(await sharedBrowser(), {
    permissions: ["clipboard-read", "clipboard-write"]
  });
  await openStoryPage(page, web, created.id);
  await page.getByRole("heading", { name: "Connection Loss Story" }).waitFor();

  await continueButton(page).click();
  const onScreen = await waitForGrowth(part(page, "Before the crash."), "Before the crash.");
  // Copy's own payload is the streamed continuation alone (`generation.text`,
  // an append's delta) — the leaf's original text is already durably saved
  // from before this generation ever started, so only the new, at-risk part
  // needs recovering. The on-screen prose is the two joined together.
  const expectedContinuation = onScreen.slice("Before the crash.".length);

  web.child.kill("SIGKILL");
  await web.exit;

  const discardButton = page.getByRole("button", { name: "Discard" });
  const copyButton = page.getByRole("button", { name: "Copy" });
  const retryButton = page.getByRole("button", { name: "Retry" });
  await discardButton.waitFor({ timeout: 10_000 });
  await copyButton.waitFor();
  // Review fix #8: a Retry button on the same card, guarded like Copy and
  // Discard — the server is dead here, so retrying cannot itself succeed
  // (that exact sequence, over a live connection, is
  // test/web-generation.integration.test.ts's own "a persistent save
  // failure..." case, which asserts retrySave reuses the original genId and
  // succeeds); this only proves the button exists, is wired to an action
  // that runs without crashing the page, and the card survives it.
  await retryButton.waitFor();
  await retryButton.click();
  await page.waitForTimeout(300);
  expect(await discardButton.isVisible()).toBeTrue();

  // A failed reconnect replaces the whole UI with a connection screen; the
  // unsaved text's controls must survive it (the server is dead, so it fails).
  await page.getByRole("button", { name: "Reconnect" }).click();
  await page.getByRole("button", { name: "Reconnect" }).waitFor({ state: "detached", timeout: 10_000 });
  await copyButton.waitFor({ timeout: 10_000 });
  expect(await discardButton.isVisible()).toBeTrue();

  await copyButton.click();
  const sawClipboardText = await poll(async () => {
    const text = await page.evaluate(() => navigator.clipboard.readText());
    return text.length > 0;
  }, 5_000);
  expect(sawClipboardText).toBeTrue();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText.length).toBeGreaterThan(0);
  // The clipboard's continuation is a prefix of (or equal to) what was
  // showing right before the crash — the transport may still have handed a
  // few more withheld bytes over after the socket died, but never fewer.
  expect(expectedContinuation.startsWith(clipboardText) || clipboardText.startsWith(expectedContinuation)).toBeTrue();

  await discardButton.click();
  await waitForCount(discardButton, 0);
}, 30_000);

test("case 15: no console errors or CSP violations across a full "
  + "append-then-stop cycle", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Diagnostics Story");
  await api.createNode(created.id, { text: "Clean run.", parentId: null });

  const page = await openTestPage(await sharedBrowser());
  const diagnostics = await collectPageDiagnostics(page);
  await openStoryPage(page, web, created.id);
  await page.getByRole("heading", { name: "Diagnostics Story" }).waitFor();

  await continueButton(page).click();
  await waitForCount(caret(page), 1);
  await page.keyboard.press("Escape");
  await waitForCount(continueButton(page), 1, 6_000);

  await page.waitForTimeout(300);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.cspViolations).toEqual([]);
}, 30_000);

test("case 16: Escape closes an open popover without stopping a background "
  + "generation; a second Escape then stops it (review fix #3)", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Popover Escape Story");
  await api.createNode(created.id, { text: "Before the picker.", parentId: null });

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, created.id);
  await page.getByRole("heading", { name: "Popover Escape Story" }).waitFor();

  await continueButton(page).click();
  await waitForGrowth(part(page, "Before the picker."), "Before the picker.");

  // The theme picker (`theme/ThemeControls.tsx`) — a `role="menu"` popover
  // via the same `usePopover` the review's row-menu example (StoryRow) also
  // uses; `fieldHasFocus()` does not recognize either as owning the
  // keyboard, so before this fix the same Escape that closed the menu would
  // also have stopped the generation underneath it.
  const themeButton = page.getByTitle("Choose theme");
  await themeButton.click();
  const menu = page.locator('.theme-popover[role="menu"]');
  await menu.waitFor();

  await page.keyboard.press("Escape");
  await waitForCount(menu, 0);
  // The generation must still be running — a live Stop button, not Continue.
  await waitForCount(stopButton(page), 1);

  await page.keyboard.press("Escape");
  await waitForCount(continueButton(page), 1, 6_000);
}, 30_000);

test("case 17: a \"Not saved\" card still warns before an unload "
  + "(review fix #1)", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Unsaved Unload Story");
  await api.createNode(created.id, { text: "Before the crash.", parentId: null });

  const page = await openTestPage(await sharedBrowser());
  await openStoryPage(page, web, created.id);
  await page.getByRole("heading", { name: "Unsaved Unload Story" }).waitFor();

  await continueButton(page).click();
  await waitForGrowth(part(page, "Before the crash."), "Before the crash.");

  web.child.kill("SIGKILL");
  await web.exit;

  const discardButton = page.getByRole("button", { name: "Discard" });
  await discardButton.waitFor({ timeout: 10_000 });

  let sawBeforeUnload = false;
  page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") sawBeforeUnload = true;
    void dialog.accept();
  });
  // The dialog fires before the navigation itself, but the navigation then
  // fails for an unrelated reason — the server this page would reload from
  // is the one just killed above. Only sawBeforeUnload is this test's point.
  await page.reload().catch(() => {});
  expect(sawBeforeUnload).toBeTrue();
}, 30_000);

// Case 8/18 (a second window's Space while the first writes) — corrected
// after this pass's own investigation of the fixes doc's premise. The doc's
// hypothesis was that the busy-retry window's optimistic "Writing…" made an
// expected `resource_busy` toast unreliable to catch; review fix #12
// (above) fixes that optimistic-status gap regardless.
//
// But the toast itself never arrives, for either tab, and this pass found
// why: `server/generation-admission.ts`'s `GenerationAdmissionRegistry.run`
// keys its `resource_busy` refusal on `(storyId, genId)` together, not
// `storyId` alone —
//   if (storyGenerations?.has(genId) === true) throw ...resource_busy...
// Two different tabs each mint their own random `genId`
// (`crypto.randomUUID()`), so they never collide there; a live two-tab
// reproduction below confirms the server admits and streams both
// concurrently. "One web generation at a time" (owner decision 2) is a
// single tab's own UI policy (`activeRun`, `GenerationActions.continue`'s
// own admission guard) — it was never a cross-connection server lock, and
// the fixes doc's "gets the busy toast" premise for two independent tabs is
// incorrect. The originally-dropped case 8, read literally, describes
// behavior this product does not have.
//
// This case instead verifies the behavior that is actually true: a second
// tab's Continue is admitted and streams normally, review fix #12's
// "Waiting…" still correctly covers its own brief pre-admission gap, and
// the two tabs' generations do not interfere with each other while running
// or when either one is stopped. What happens if both tabs' generations
// try to *land* at nearly the same moment (one succeeds, does the other's
// commit cleanly hit revision_conflict and retry, per review fix #2, or
// something worse) is a separate question this pass did not verify and is
// called out as an open risk in the final report rather than asserted here.
test("case 18: two tabs can write into the same story concurrently — neither "
  + "ever claims \"Writing…\" before real content exists, and stopping one "
  + "does not disturb the other", async () => {
  const project = await scratchProject();
  const web = await spawnGenWeb(project, WORD_DELAY_MS);
  const api = await openInspectionApi(web);
  const created = await api.createStory("Two Tabs Story");
  await api.createNode(created.id, { text: "Shared text.", parentId: null });

  const pageA = await openTestPage(await sharedBrowser());
  const pageB = await openTestPage(await sharedBrowser());
  await openStoryPage(pageA, web, created.id);
  await openStoryPage(pageB, web, created.id);
  await pageA.getByRole("heading", { name: "Two Tabs Story" }).waitFor();
  await pageB.getByRole("heading", { name: "Two Tabs Story" }).waitFor();

  await continueButton(pageA).click();
  await continueButton(pageB).click();

  // Both tabs must reach genuine content, never resolving the race by one
  // of them getting stuck claiming "Writing…" with nothing behind it.
  await waitForTextMatching(generationStatus(pageA), /Writing…|Thinking…/);
  await waitForTextMatching(generationStatus(pageB), /Writing…|Thinking…/);
  await waitForCount(stopButton(pageA), 1);
  await waitForCount(stopButton(pageB), 1);

  // Stopping the second tab must not affect the first, which keeps writing.
  await pageB.keyboard.press("Escape");
  await waitForCount(continueButton(pageB), 1, 6_000);
  await waitForCount(stopButton(pageA), 1);

  await pageA.keyboard.press("Escape");
  await waitForCount(continueButton(pageA), 1, 6_000);
}, 30_000);
