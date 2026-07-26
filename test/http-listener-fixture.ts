import { createServer } from "node:http";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export async function privateTemporaryDirectory(
  t: TestContext,
  prefix: string
): Promise<string> {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), prefix))
  );
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function availableLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === "string") {
    throw new Error("Port probe did not expose a TCP address");
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

export async function rejectionOf(
  promise: Promise<unknown>
): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}
