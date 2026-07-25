import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertNoDarwinExtendedAllow } from "../../server/storage-privacy-darwin.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("Darwin extended ACL privacy", () => {
  test("accepts no ACL and deny-only ACLs but rejects allow ACLs", async () => {
    if (process.platform !== "darwin") return;
    const root = await mkdtemp(path.join(tmpdir(), "1667-darwin-acl-"));
    roots.push(root);
    const plain = await privateFile(root, "plain");
    const denied = await privateFile(root, "denied");
    const allowed = await privateFile(root, "allowed");
    const username = userInfo().username;

    await execFileAsync("/bin/chmod", ["+a", `user:${username} deny execute`, denied]);
    await execFileAsync("/bin/chmod", ["+a", `user:${username} allow read`, allowed]);

    await assertNoDarwinExtendedAllow(plain, "test file");
    await assertNoDarwinExtendedAllow(denied, "test file");

    const allowError = await rejection(
      assertNoDarwinExtendedAllow(allowed, "test file")
    );
    expect(allowError).toMatchObject({
      code: "data_directory_unowned"
    });

    const missingError = await rejection(
      assertNoDarwinExtendedAllow(path.join(root, "missing"), "test file")
    );
    expect(missingError).toBeDefined();
  });
});

async function rejection(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

async function privateFile(root: string, name: string): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, "");
  await chmod(file, 0o600);
  return file;
}
