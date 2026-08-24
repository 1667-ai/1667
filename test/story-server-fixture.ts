import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type test from "node:test";
import { writeInitialDataDirectoryFormat } from "../server/data-directory-format.js";
import {
  fetchWithApiProtocol,
  stopTestServerProcess,
  waitForTestServer
} from "./http-test-client.js";

/**
 * Make a data directory that already holds an empty library.
 *
 * The product entry point writes the starter vault only when it publishes the
 * format marker. This function publishes the marker first. The spawned server
 * then opens an existing library and writes no starter vault. The server-start
 * budget covers the behavior under test.
 *
 * Tests of the starter vault operate StoryService directly in
 * starter-vault.test.ts. This function does not reduce their cover.
 *
 * Format 2 is the format the runtime data-directory lock publishes.
 */
export async function emptyLibraryDataDirectory(prefix: string): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  await writeInitialDataDirectoryFormat(dataDir, 2);
  return dataDir;
}

/** Start the product server on an empty library and give back its origin. The
 * server and its data directory close when the test ends. */
export async function testApp(
  t: test.TestContext,
  temporaryPrefix: string
): Promise<string> {
  const dataDir = await emptyLibraryDataDirectory(temporaryPrefix);
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts", "--print-logs"],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, AI_1667_DATA: dataDir, AI_1667_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  server.stdout?.on("data", (chunk) => { output += String(chunk); });
  server.stderr?.on("data", (chunk) => { output += String(chunk); });
  t.after(async () => {
    await stopTestServerProcess(server);
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = await waitForTestServer(server, () => output);
  return base;
}

/** Read a JSON body, and fail the test when the request does not succeed. */
export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithApiProtocol(url, init);
  if (!response.ok) assert.fail(`${response.status} ${await response.text()}`);
  return await response.json() as T;
}
