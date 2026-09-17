import type { ElectronApplication, Locator, Page } from "playwright";

/** The Library destination holds `.new-story-button` and `.story-row`s now
 * that they are no longer in the always-visible topbar. Tests that click
 * either while a story may already be open must go there first. */
export async function goToLibrary(page: Page): Promise<void> {
  await page.locator(".tab-library").click();
  await page.waitForSelector(".tab-content.library", { timeout: 15_000 });
}

/** Creates a story from Library and waits for Write to show its title. Used
 * by every Map e2e test that needs a fresh story to build a stemma on. */
export async function createStory(page: Page, title: string): Promise<void> {
  await goToLibrary(page);
  await page.locator(".new-story-button").click();
  await page.waitForSelector(".modal-card", { timeout: 15_000 });
  await page.locator(".modal-input").fill(title);
  await page.locator(".modal-submit").click();
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 15_000 });
}

/** Types `text` into the composer and saves it as a manual part, waiting for
 * the manuscript to grow by one. */
export async function saveManualPart(page: Page, text: string): Promise<void> {
  const before = await page.locator(".manuscript-part").count();
  await page.locator(".composer-input").fill(text);
  await page.locator(".composer-manual").click();
  await page.waitForFunction((expected) => document.querySelectorAll(".manuscript-part").length === expected, before + 1, { timeout: 15_000 });
}

/** A part just created or switched to can keep re-rendering for a beat after
 * its own `.manuscript-part` count first satisfies a caller's wait (a
 * trailing aside/story refresh replaces the whole tree again). Waiting for
 * the render root to go quiet dodges the window where a double-click's two
 * halves can land on two different generations of the DOM. */
async function waitForRenderQuiet(page: Page, quietMs = 800, timeoutMs = 10_000): Promise<void> {
  // Every callback below stays an inline, unnamed argument (never a `const
  // fn = () => …` binding) — tsx/esbuild's `keepNames` wraps a *named*
  // function binding in a `__name(...)` call that does not exist once
  // Playwright re-parses this function's stringified source in the page.
  await page.evaluate((args) => {
    const root = document.querySelector("#app");
    if (root === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => { observer.disconnect(); resolve(); }, args.quietMs);
      });
      observer.observe(root, { childList: true, subtree: true });
      let timer = setTimeout(() => { observer.disconnect(); resolve(); }, args.quietMs);
      setTimeout(() => { observer.disconnect(); resolve(); }, args.timeoutMs);
    });
  }, { quietMs, timeoutMs });
}

/** Phase 3: a part shows its text in `.part-prose` at rest; double-clicking
 * it opens `textarea.part-text` in place. Every test that used to read or
 * fill `.part-text` directly must go through here first.
 *
 * Retries the whole gesture, not just the click: a native double-click is
 * one browser-level gesture built from a single cached coordinate, so if a
 * trailing render lands between its two halves the browser can resolve them
 * against two different elements and silently never raise `dblclick` at
 * all — no exception, just no edit mode. Re-resolving the locator and
 * clicking again (after the DOM is quiet) is what actually recovers. */
export async function editPart(page: Page, nth: number | "last"): Promise<Locator> {
  const part = nth === "last" ? page.locator(".manuscript-part").last() : page.locator(".manuscript-part").nth(nth);
  const text = part.locator(".part-text");
  const deadline = Date.now() + 20_000;
  for (;;) {
    await waitForRenderQuiet(page);
    try {
      await part.locator(".part-prose").dblclick({ timeout: 2_000 });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      continue;
    }
    try {
      await text.waitFor({ state: "visible", timeout: 1_500 });
      return text;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
  }
}

/** Settings (phase 4a) shows one section sheet at a time behind a left nav.
 * Click the nav entry for `section` and wait for its sheet to mount before
 * touching any field that lives in it. */
/** Open one Settings section. A late settings result can rebuild the page
 *  between mousedown and mouseup and drop the click, so retry the click until
 *  the sheet shows. */
export async function openSettingsSection(page: Page, section: string): Promise<void> {
  const sheet = `.settings-sheet[data-settings-section="${section}"]`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.locator(`.settings-sections [data-settings-section="${section}"]`).click();
    try {
      await page.waitForSelector(sheet, { timeout: 3_000 });
      return;
    } catch {
      // The click landed on a replaced element; try again.
    }
  }
  await page.waitForSelector(sheet, { timeout: 15_000 });
}

/** Retakes ¶2 (the manuscript's 2nd part, 0-based index 1), waiting for the
 * new take to finish streaming. Used by every Map e2e test that needs a fork
 * with 2 takes at ¶2 — after this, the new take is the current (on-path)
 * one. */
export async function retakeSecondPart(page: Page): Promise<void> {
  const second = page.locator(".manuscript-part").nth(1);
  await second.locator(".part-prose").click();
  await page.waitForFunction(() => document.querySelectorAll(".manuscript-part")[1]?.classList.contains("focused") === true, undefined, { timeout: 15_000 });
  await second.locator(".part-retake").click();
  await page.waitForSelector(".stream-card", { timeout: 30_000 });
  await page.waitForSelector(".stream-card", { state: "detached", timeout: 30_000 });
}

/** Clicks the `dotIndex`-th take-gauge dot on the focused part and waits for
 * its take count to read `expectTakeCount` (for example `"take 1/2"`). */
export async function switchTakeGaugeDot(page: Page, dotIndex: number, expectTakeCount: string): Promise<void> {
  const retaken = page.locator(".manuscript-part.focused");
  await retaken.locator(".take-gauge-dot").nth(dotIndex).click();
  await page.waitForFunction(
    (expected) => document.querySelector(".manuscript-part.focused .part-take-count")?.textContent?.includes(expected) === true,
    expectTakeCount,
    { timeout: 15_000 }
  );
}

/** Let the native dirty-window prompt choose Discard during test teardown. */
export async function closeDesktopApp(app: ElectronApplication): Promise<void> {
  for (const page of app.windows()) {
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => undefined); });
  }
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 0;
    });
  } catch {
    // The application may already have exited after closing its last window.
  }
  try {
    await app.close();
  } catch {
    // Preserve the original test failure when teardown races app exit.
  }
}
