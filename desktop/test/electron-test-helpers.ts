import type { ElectronApplication, Page } from "playwright";

/** The Library destination holds `.new-story-button` and `.story-row`s now
 * that they are no longer in the always-visible topbar. Tests that click
 * either while a story may already be open must go there first. */
export async function goToLibrary(page: Page): Promise<void> {
  await page.locator(".tab-library").click();
  await page.waitForSelector(".tab-content.library", { timeout: 15_000 });
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
