import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { decodeHttpAuthRecord } from "../../shared/http-auth.js";
import { HttpOperationClient } from "../../shared/http-operation-client.js";
import {
  HTTP_OPERATION_CANCEL_GRACE_MS
} from "../../shared/http-operation-protocol.js";
import { runStandalone } from "./standalone-smoke-process.js";

interface SupervisedServeAccess {
  readonly origin: string;
  readonly instanceId: string;
  readonly operations: HttpOperationClient;
}

/** Exercise Linux kill/recovery and explicit fail-closed behavior elsewhere. */
export async function smokeSupervisedServe(
  executable: string,
  directory: string,
  environment: Record<string, string>
): Promise<void> {
  const dataDir = path.join(directory, "serve-data");
  const help = await runStandalone(
    executable,
    ["serve", "--help"],
    directory,
    environment
  );
  if (help.exitCode !== 0
    || !help.stdout.includes("1667 serve [--data <path>]")
    || help.stderr !== "") {
    throw new Error("Packaged serve help is unavailable or noisy");
  }
  const usage = await runStandalone(
    executable,
    ["serve", "--unknown"],
    directory,
    environment
  );
  if (usage.exitCode !== 2
    || !usage.stderr.startsWith("1667 serve: unknown serve option")
    || usage.stderr.includes("\n    at ")
    || usage.stderr.length > 1_000) {
    throw new Error("Packaged serve usage failure was not bounded");
  }
  for (const empty of ["--data=", "--port="]) {
    const refusal = await runStandalone(
      executable,
      ["serve", empty],
      directory,
      environment
    );
    if (refusal.exitCode !== 2
      || !refusal.stderr.includes(`${empty.slice(0, -1)} requires a value`)
      || refusal.stderr.includes("\n    at ")) {
      throw new Error(`Packaged serve accepted empty ${empty}`);
    }
  }
  if (process.platform !== "linux") {
    const refusal = await runStandalone(
      executable,
      ["serve", "--data", dataDir, "--port", "0"],
      directory,
      environment
    );
    if (refusal.exitCode === 0
      || !/requires a packaged Linux/.test(refusal.stderr)) {
      throw new Error("Unsupported supervised serve did not fail closed");
    }
    return;
  }
  const child = Bun.spawn(
    [
      executable,
      "serve",
      "--data",
      dataDir,
      "--port",
      "0"
    ],
    {
      cwd: directory,
      env: environment,
      stdout: "pipe",
      stderr: "pipe"
    }
  );
  try {
    const origin = await readServeOrigin(child.stdout);
    const first = await supervisedServeAccess(origin, environment);
    await smokeSupervisedRequest(first);
    await smokeSettledDeadline(
      first,
      child.pid,
      await supervisedChildPid(child.pid)
    );
    await smokeLockGuidance(
      executable,
      directory,
      environment,
      dataDir,
      origin
    );
    await first.operations.reserve(
      "GET",
      "/api/stories",
      first.instanceId,
      30_000
    );
    const firstChildPid = await supervisedChildPid(child.pid);
    process.kill(firstChildPid, "SIGKILL");
    const recoveredOrigin = await readServeOrigin(child.stdout);
    const secondChildPid = await supervisedChildPid(child.pid);
    if (secondChildPid === firstChildPid || processExists(firstChildPid)) {
      throw new Error(
        "Supervised serve replacement overlapped the terminated child"
      );
    }
    await smokeSupervisedRequest(
      await supervisedServeAccess(recoveredOrigin, environment)
    );
  } finally {
    child.kill("SIGTERM");
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(
        `Supervised serve did not stop cleanly (${exitCode}): `
          + stderr.trim()
      );
    }
  }
  await smokeSupervisorDeathContainment(
    executable,
    directory,
    environment,
    dataDir
  );
  await smokeAlternateDataGuidance(executable, directory, environment);
  await smokeDefaultPortInitialization(executable, directory, environment);
}

async function smokeSettledDeadline(
  access: SupervisedServeAccess,
  supervisorPid: number,
  childPid: number
): Promise<void> {
  const lease = await access.operations.reserve(
    "GET",
    "/api/stories",
    access.instanceId,
    25
  );
  const response = await fetch(`${access.origin}/api/stories`, {
    headers: lease.headers
  });
  await response.arrayBuffer();
  await lease.settle();
  await new Promise((resolve) =>
    setTimeout(resolve, HTTP_OPERATION_CANCEL_GRACE_MS + 100));
  if (!processExists(childPid)
    || await supervisedChildPid(supervisorPid) !== childPid) {
    throw new Error("A stale operation watchdog killed the settled child");
  }
}

async function smokeLockGuidance(
  executable: string,
  directory: string,
  environment: Record<string, string>,
  dataDir: string,
  origin: string
): Promise<void> {
  const contention = await runStandalone(
    executable,
    ["--data", dataDir, "--render-once", "--size", "20x10"],
    directory,
    environment
  );
  if (contention.exitCode !== 1
    || !contention.stderr.includes("already open by")
    || !contention.stderr.includes("1667 --url")
    || !contention.stderr.includes("1667 --data <project-root>")) {
    throw new Error("Packaged lock contention guidance was not actionable");
  }
  const attached = await runStandalone(
    executable,
    ["--url", origin, "--render-once", "--size", "20x10"],
    directory,
    { ...environment, AI_1667_DATA: "relative-data-must-be-ignored" }
  );
  if (attached.exitCode !== 0) {
    throw new Error(`Lock guidance attach command failed: ${attached.stderr}`);
  }
}

async function smokeAlternateDataGuidance(
  executable: string,
  directory: string,
  environment: Record<string, string>
): Promise<void> {
  const alternative = path.join(directory, "alternative-data");
  const initialized = await runStandalone(
    executable,
    [
      "--data",
      alternative,
      "--render-once",
      "--size",
      "20x10"
    ],
    directory,
    environment
  );
  if (initialized.exitCode !== 0) {
    throw new Error(`Lock guidance alternate-data command failed: ${initialized.stderr}`);
  }
}

async function smokeDefaultPortInitialization(
  executable: string,
  directory: string,
  environment: Record<string, string>
): Promise<void> {
  const dataDir = path.join(directory, "default-port-data");
  const supervisor = Bun.spawn(
    [
      executable,
      "serve",
      "--data",
      dataDir
    ],
    {
      cwd: directory,
      env: environment,
      stdout: "pipe",
      stderr: "pipe"
    }
  );
  try {
    const origin = await readServeOrigin(supervisor.stdout);
    if (origin !== "http://127.0.0.1:7373") {
      throw new Error(`Default serve selected the wrong origin: ${origin}`);
    }
  } finally {
    supervisor.kill("SIGTERM");
    const exitCode = await supervisor.exited;
    if (exitCode !== 0) {
      throw new Error(
        `Default-port serve did not stop cleanly: `
          + await new Response(supervisor.stderr).text()
      );
    }
  }
}

async function supervisedServeAccess(
  origin: string,
  environment: Record<string, string>
): Promise<SupervisedServeAccess> {
  const instance = await fetch(`${origin}/.well-known/1667-instance`)
    .then(async (response) => await response.json()) as {
      instanceId: string;
    };
  const stateHttp = path.join(
    environment.XDG_STATE_HOME!,
    "1667",
    "http"
  );
  const records = (await readdir(stateHttp)).filter((name) =>
    name.endsWith(".json"));
  const decoded = await Promise.all(records.map(async (name) =>
    decodeHttpAuthRecord(await readFile(path.join(stateHttp, name)))));
  const matching = decoded.filter((record) =>
    record.origin === origin && record.instanceId === instance.instanceId);
  if (matching.length !== 1) {
    throw new Error(
      "Supervised serve did not publish one exact origin/instance auth record"
    );
  }
  const authRecord = matching[0]!;
  return {
    origin,
    instanceId: instance.instanceId,
    operations: new HttpOperationClient({ root: origin, authRecord, fetch })
  };
}

async function smokeSupervisedRequest(
  access: SupervisedServeAccess
): Promise<void> {
  const lease = await access.operations.reserve(
    "GET",
    "/api/stories",
    access.instanceId,
    30_000
  );
  const response = await fetch(`${access.origin}/api/stories`, {
    headers: lease.headers
  });
  const stories: unknown = await response.json();
  if (!response.ok || !Array.isArray(stories)) {
    throw new Error("Supervised serve operation-session smoke failed");
  }
  await lease.settle();
}

async function supervisedChildPid(supervisorPid: number): Promise<number> {
  const childrenFile = `/proc/${supervisorPid}/task/${supervisorPid}/children`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const children = (await readFile(childrenFile, "utf8"))
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    if (children.length === 1 && Number.isSafeInteger(children[0])) {
      return children[0]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Supervised serve did not retain exactly one child");
}

async function smokeSupervisorDeathContainment(
  executable: string,
  directory: string,
  environment: Record<string, string>,
  dataDir: string
): Promise<void> {
  const supervisor = Bun.spawn(
    [executable, "serve", "--data", dataDir, "--port", "0"],
    {
      cwd: directory,
      env: environment,
      stdout: "pipe",
      stderr: "pipe"
    }
  );
  await readServeOrigin(supervisor.stdout);
  const childPid = await supervisedChildPid(supervisor.pid);
  supervisor.kill("SIGKILL");
  await supervisor.exited;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!processExists(childPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.kill(childPid, "SIGKILL");
  throw new Error("Supervisor death orphaned the authority-owning child");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertMissing(target: string): Promise<void> {
  try {
    await readFile(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
  }
  throw new Error(`Supervised smoke unexpectedly created ${target}`);
}

async function readServeOrigin(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const timeout = setTimeout(() => {
    void reader.cancel("serve startup timeout");
  }, 30_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffered);
      if (match !== null) return match[1]!;
    }
    throw new Error(`Supervised serve exited before readiness: ${buffered}`);
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
