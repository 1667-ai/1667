import type { ElectronApplication, Locator, Page } from "playwright";

/** The Library destination holds `.new-story-button` and `.story-row`s now
 * that they are no longer in the always-visible topbar. Tests that click
 * either while a story may already be open must go there first. */
export async function goToLibrary(page: Page): Promise<void> {
  await page.locator(".tab-library").click();
  await page.waitForSelector(".tab-content.library", { timeout: 15_000 });
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
