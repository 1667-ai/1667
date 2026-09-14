import type { ElectronApplication } from "playwright";

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
