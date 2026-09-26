import { spawn } from "node:child_process";

/**
 * Shared by `cli/src/web-command.ts` (opens the URL `1667 web` just printed)
 * and `cli/scripts/web-dev.ts` (opens the Vite dev URL): launch the
 * platform's own "open a URL" command. An opener that never starts (missing
 * binary, spawn failure) rejects; both callers treat that as advisory, not
 * fatal — the address is already printed either way.
 */
export function openInBrowser(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const [command, args] = platformOpenCommand(url);
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function platformOpenCommand(url: string): readonly [string, readonly string[]] {
  if (process.platform === "darwin") return ["open", [url]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
