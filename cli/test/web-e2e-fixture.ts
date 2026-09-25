import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

/**
 * `1667 web` (#409) spawn helpers shared by `web-command-e2e.test.ts` and
 * `web-bridge-e2e.test.ts`. Both spawn the real CLI (the standalone
 * entrypoint, the same one the shell wrapper runs) and drive it as an
 * external client only — an HTTP client, a WebSocket, a raw socket, and OS
 * signals — matching CLAUDE.md's preference for an end-to-end test over one
 * that pokes at internal structure.
 */

/** `1667 web` reads no input, so stdin is closed and both output streams are
 * piped for capture. */
export type WebChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export const STANDALONE_ENTRY = fileURLToPath(new URL("../src/standalone.ts", import.meta.url));
/** Also used by `cli/scripts/standalone-smoke-web.ts`, so a compiled
 * `1667 web`'s own startup line is matched the same way this fixture's own
 * spawns are. */
export const READY_LINE = /^1667 web: serving (.+) at (http:\/\/\S+)$/m;

/** Bun's `WebSocket` accepts `{ protocols, headers }` as its second
 * constructor argument (verified against Bun 1.3.14); the DOM lib type only
 * declares `string | string[]`. Shared by `web-bridge-e2e.test.ts` and
 * `cli/test-web-ui/web-ui-fixture.ts` — both open a bridge socket as an
 * external client, so both need this same cast. */
type BunWebSocketConstructor = new (
  url: string,
  init?: {
    readonly protocols?: readonly string[];
    readonly headers?: Readonly<Record<string, string>>;
  }
) => WebSocket;
export const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;

const roots: string[] = [];
const children: WebChildProcess[] = [];

/** Register once per test file, in an `afterEach`: drains every scratch
 * project directory and every child process a `spawnWeb`/`spawnWebRaw` call
 * in that file created. */
export async function cleanupWebProcesses(): Promise<void> {
  await Promise.all(children.splice(0).map(killChild));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export interface SpawnedWeb {
  readonly child: WebChildProcess;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  stdoutText(): string;
  stderrText(): string;
}

export interface ReadyWeb extends SpawnedWeb {
  readonly url: string;
  readonly origin: string;
  readonly port: string;
  readonly token: string;
  readonly projectRoot: string;
}

export interface ScratchProject {
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
}

/** A fresh project directory and an isolated machine-tier override, so a test
 * run never touches this machine's real 1667 state. */
export async function scratchProject(): Promise<ScratchProject> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-web-e2e-"));
  roots.push(root);
  return {
    dataDir: path.join(root, "project"),
    env: { ...process.env, AI_1667_STATE: path.join(root, "machine") }
  };
}

/** Spawn `1667 web` without waiting for readiness — for scenarios where
 * startup itself is expected to fail. */
export function spawnWebRaw(args: readonly string[], env: NodeJS.ProcessEnv): SpawnedWeb {
  const child = spawn(process.execPath, [STANDALONE_ENTRY, "web", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exit, stdoutText: () => stdout, stderrText: () => stderr };
}

/** Spawn `1667 web` and wait for the line it prints once the server is up. */
export async function spawnWeb(
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<ReadyWeb> {
  const spawned = spawnWebRaw(args, env);
  const { root, url } = await new Promise<{ root: string; url: string }>((resolve, reject) => {
    const onData = () => {
      const match = READY_LINE.exec(spawned.stdoutText());
      if (match === null) return;
      spawned.child.stdout.off("data", onData);
      spawned.child.off("exit", onExit);
      resolve({ root: match[1]!, url: match[2]! });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(new Error(
        `1667 web exited before it printed its URL (code ${code}, signal ${signal}): `
          + spawned.stderrText()
      ));
    };
    spawned.child.stdout.on("data", onData);
    spawned.child.once("exit", onExit);
  });
  const parsed = new URL(url);
  const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token");
  if (token === null) throw new Error(`printed URL has no token fragment: ${url}`);
  return { ...spawned, url, origin: parsed.origin, port: parsed.port, token, projectRoot: root };
}

export async function killChild(child: WebChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
