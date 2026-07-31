import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SHELL_INSTALLER_HELPERS
} from "../scripts/release-install-script-shell-lib.js";
import {
  execFileAsync
} from "./release-install-script-fixture.js";

const CASES = [
  {
    os: "Darwin",
    arch: "arm64",
    target: "darwin-arm64",
    error: null
  },
  {
    os: "Darwin",
    arch: "x86_64",
    target: "darwin-x64",
    error: null
  },
  {
    os: "Darwin",
    arch: "ppc64",
    target: null,
    error: /Unsupported macOS architecture: ppc64/
  },
  {
    os: "Linux",
    arch: "aarch64",
    target: "linux-arm64",
    error: null
  },
  {
    os: "Linux",
    arch: "arm64",
    target: "linux-arm64",
    error: null
  },
  {
    os: "Linux",
    arch: "x86_64",
    target: "linux-x64",
    error: null
  },
  {
    os: "Linux",
    arch: "amd64",
    target: "linux-x64",
    error: null
  },
  {
    os: "Linux",
    arch: "riscv64",
    target: null,
    error: /Unsupported Linux architecture: riscv64/
  },
  {
    os: "FreeBSD",
    arch: "x86_64",
    target: null,
    error: /Unsupported operating system: FreeBSD/
  }
] as const;

const HELPER_SCRIPT = `
die() {
  printf 'error: %s\\n' "$1" >&2
  exit 1
}
${SHELL_INSTALLER_HELPERS}
detect_target
`;

test("detect_target selects the OS and architecture matrix", async (t) => {
  const cache = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(cache, { recursive: true, mode: 0o755 });
  await chmod(cache, 0o755);
  const root = await mkdtemp(path.join(cache, "detect-target-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(
    path.join(root, "uname"),
    `#!/bin/sh
if [ "$1" = "-s" ]; then printf '%s\\n' "$TEST_UNAME_S"; exit 0; fi
if [ "$1" = "-m" ]; then printf '%s\\n' "$TEST_UNAME_M"; exit 0; fi
exit 1
`,
    { mode: 0o755 }
  );
  const envPath = `${root}:${process.env.PATH ?? ""}`;

  for (const entry of CASES) {
    const run = execFileAsync("sh", ["-c", HELPER_SCRIPT], {
      env: {
        ...process.env,
        PATH: envPath,
        TEST_UNAME_S: entry.os,
        TEST_UNAME_M: entry.arch
      }
    });
    if (entry.target !== null) {
      const { stdout } = await run;
      assert.equal(stdout.trim(), entry.target);
      continue;
    }
    const expectedError = entry.error;
    await assert.rejects(run, (error: unknown) => {
      if (
        typeof error !== "object"
        || error === null
        || !("stderr" in error)
        || typeof error.stderr !== "string"
      ) {
        return false;
      }
      assert.match(error.stderr, expectedError);
      return true;
    });
  }
});
