import {
  mkdtemp,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export async function temporaryDiagnosticDirectory(
  t: TestContext
): Promise<string> {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-internal-error-log-"))
  );
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}
