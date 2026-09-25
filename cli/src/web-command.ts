import { spawn } from "node:child_process";
import { createWorkerHost, type WorkerHost, type WorkerRecoveryWarning } from "../../host/worker-host.js";
import { generateWebToken, startWebServer, type WebServer } from "../../host/web-server.js";
import { startWebBridgeServer, type WebBridgeHub } from "../../host/web-bridge-server.js";
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
 * the Worker host so the project lock stays taken, and serve the app plus a
 * WebSocket bridge to that Worker on loopback, behind a per-run token.
 */
export async function runWebCommand(argv: readonly string[]): Promise<void> {
  const command = parseWebCommand(argv);
  const opened = await openProject({ data: command.data, global: command.global });
  if (opened === null) return;

  // The hub does not exist until after the Worker host starts (it wraps the
  // http server the host has no reason to know about), but `createWorkerHost`
  // needs an `onRecoveryWarnings` callback now. This cell lets that callback
  // reach the hub once it does. It returns `void`, never `true`: the web UI
  // surfaces a recovery warning with its own Dismiss affordance instead of
  // the interactive TUI's hard fence, so a new mutation is never blocked on it.
  let hub: WebBridgeHub | null = null;
  const host: WorkerHost = await createWorkerHost({
    dataDir: opened.project.directory,
    ...embeddedVaultOptions(opened.vault),
    onRecoveryWarnings: (warnings) => { hub?.broadcastRecoveryWarnings(warnings); }
  });
  // Listen for Ctrl+C before anything is printed: once the URL is out, a
  // signal must always reach this handler and shut down cleanly, and a
  // signal during startup should still release the project lock.
  const stop = listenForStop(host);
  try {
    const recoveryWarnings: readonly WorkerRecoveryWarning[] = await host.recovery;
    if (recoveryWarnings.length > 0) {
      process.stderr.write(
        `1667 web: ${recoveryWarnings.length} recovery warning`
          + `${recoveryWarnings.length === 1 ? "" : "s"} from startup.\n`
      );
    }

    if (stop.settled()) return await finishStop(stop.outcome);

    const token = generateWebToken();
    let server: WebServer;
    try {
      server = await startWebServer({
        port: command.port,
        token,
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
      hub = startWebBridgeServer({
        httpServer: server.httpServer,
        host,
        context: { port: server.port, tokenBuffer: Buffer.from(token, "hex") }
      });
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
      await finishStop(stop.outcome);
    } finally {
      // The http server's own connection draining may not reach an
      // already-upgraded WebSocket (host/web-bridge-server.ts's `closeAll`
      // doc explains why), so the hub closes those first.
      hub?.closeAll();
      await server.close();
    }
  } finally {
    stop.dispose();
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

interface StopListener {
  readonly outcome: Promise<StopOutcome>;
  settled(): boolean;
  dispose(): void;
}

/** Listen for a shutdown signal or the Worker dying on its own, whichever
 * comes first. `dispose` removes both signal listeners, so a run that stops
 * one way does not leave the other armed. */
function listenForStop(host: WorkerHost): StopListener {
  let settled = false;
  let resolveOutcome: (outcome: StopOutcome) => void = () => undefined;
  const outcome = new Promise<StopOutcome>((resolve) => {
    resolveOutcome = (value) => {
      settled = true;
      resolve(value);
    };
  });
  const onSignal = () => resolveOutcome({ kind: "signal" });
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  void host.failure.then((error) => resolveOutcome({ kind: "failure", error }));
  return {
    outcome,
    settled: () => settled,
    dispose: () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  };
}

async function finishStop(outcome: Promise<StopOutcome>): Promise<void> {
  const stopped = await outcome;
  if (stopped.kind === "failure") throw stopped.error;
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
