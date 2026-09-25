import { spawn } from "node:child_process";
import { createWorkerHost, type WorkerHost, type WorkerRecoveryWarning } from "../../host/worker-host.js";
import { startWebServer, type WebServer } from "../../host/web-server.js";
import { formatBuildVersion } from "../../shared/build-identity.js";
import { terminalLineText } from "../../shared/terminal-text.js";
import { embeddedVaultOptions, openProject } from "./embedded-project.js";
import { inlineValue, separatedValue } from "./project-command.js";

/** A fresh port on every run gives every run a fresh browser origin, so
 * nothing an earlier program left on that origin (a service worker, say) can
 * read the new token from the URL fragment. */
const DEFAULT_PORT = 0;

export interface WebCommand {
  readonly data: string | null;
  readonly global: boolean;
  readonly port: number;
  readonly open: boolean;
}

export function parseWebCommand(argv: readonly string[]): WebCommand {
  let data = process.env.AI_1667_DATA ?? null;
  let explicitData = false;
  let global = false;
  let port = DEFAULT_PORT;
  let open = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--global") global = true;
    else if (argument === "--no-open") open = false;
    else if (argument === "--data") {
      data = separatedValue(argv, ++index, argument);
      explicitData = true;
    }
    else if (argument === "--port") port = webPort(separatedValue(argv, ++index, argument));
    else if (argument.startsWith("--data=")) {
      data = inlineValue(argument, "--data");
      explicitData = true;
    }
    else if (argument.startsWith("--port=")) port = webPort(inlineValue(argument, "--port"));
    else throw new Error(`unknown web option: ${argument}`);
  }
  // Like the TUI: only an explicit --data conflicts; AI_1667_DATA does not.
  if (global && explicitData) {
    throw new Error("--global and --data select different projects");
  }
  return { data, global, port, open };
}

function webPort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be between 0 and 65535");
  }
  return port;
}

/**
 * `1667 web`: open the story project exactly like the embedded TUI does, hold
 * the Worker host so the project lock stays taken, and serve a placeholder
 * page on loopback behind a per-run token. Step 1 of the web UI (#409) — no
 * WebSocket bridge and no app bundle yet, only proof that the local server
 * runs.
 */
export async function runWebCommand(argv: readonly string[]): Promise<void> {
  const command = parseWebCommand(argv);
  const opened = await openProject({ data: command.data, global: command.global });
  if (opened === null) return;

  const host: WorkerHost = await createWorkerHost({
    dataDir: opened.project.directory,
    ...embeddedVaultOptions(opened.vault)
  });
  try {
    const recoveryWarnings: readonly WorkerRecoveryWarning[] = await host.recovery;
    if (recoveryWarnings.length > 0) {
      process.stderr.write(
        `1667 web: ${recoveryWarnings.length} recovery warning`
          + `${recoveryWarnings.length === 1 ? "" : "s"} from startup.\n`
      );
    }

    let server: WebServer;
    try {
      server = await startWebServer({
        port: command.port,
        projectLabel: opened.project.root,
        version: formatBuildVersion()
      });
    } catch (error) {
      throw new Error(
        `could not start 1667 web on 127.0.0.1:${command.port}: ${errorMessage(error)}. `
          + "Try a different --port."
      );
    }
    try {
      process.stdout.write(
        `1667 web: serving ${terminalLineText(opened.project.root)} at ${server.url}\n`
      );
      process.stdout.write("Press Ctrl+C to stop.\n");
      if (command.open) {
        try {
          await openInBrowser(server.url);
        } catch (error) {
          process.stderr.write(
            `1667 web: could not open a browser automatically (${errorMessage(error)}). `
              + "Open the address above yourself.\n"
          );
        }
      }
      // A worker failure is not swallowed here: it propagates like any other
      // error, all the way to `runCli`, which already gives a
      // `BackendRestartRequiredError` its own exit path — the same one the
      // interactive TUI uses. Printing and swallowing it here would divert
      // it from that path.
      const outcome = await waitForStop(host);
      if (outcome.kind === "failure") throw outcome.error;
    } finally {
      await server.close();
    }
  } finally {
    // `host.dispose()` can itself throw `BackendRestartRequiredError` (it
    // keeps the project lock when the worker's exit is unproven). Letting
    // that propagate from a `finally` — rather than catching it — is what
    // gets it to `runCli`'s handler.
    await host.dispose();
  }
}

type StopOutcome =
  | { readonly kind: "signal" }
  | { readonly kind: "failure"; readonly error: Error };

/** Wait for a shutdown signal or the Worker dying on its own, whichever
 * comes first. Both listeners are always removed, so a run that stops one
 * way does not leave the other armed. */
async function waitForStop(host: WorkerHost): Promise<StopOutcome> {
  let onSignal: () => void = () => undefined;
  try {
    return await new Promise<StopOutcome>((resolve) => {
      onSignal = () => resolve({ kind: "signal" });
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      void host.failure.then((error) => resolve({ kind: "failure", error }));
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** Launch the platform opener. An opener that never starts (missing binary,
 * spawn failure) rejects; the caller treats that as advisory, not fatal. */
function openInBrowser(url: string): Promise<void> {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
