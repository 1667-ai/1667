import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFailures } from "../scripts/test-shard-failures.js";

const tuiRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shardScript = path.join(tuiRoot, "scripts", "test-shards.ts");

test("TUI test command runs every shard in a fresh Bun process", () => {
  const result = spawnSync(process.execPath, [shardScript, "--help"], {
    cwd: tuiRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000
  });

  expect(result.status).toBe(0);
  expect(result.signal).toBe(null);
  expect(result.stderr).toBe("");
  const pids = [...result.stdout.matchAll(
    /^    Bun process (\d+)$/gmu
  )].map((match) => match[1]);
  expect(pids).toHaveLength(16);
  expect(new Set(pids).size).toBe(16);
  expect(result.stdout).toContain("All 16 TUI test shards passed.");
});

test("TUI test retries keep each supported Bun test filename", () => {
  const failures = parseFailures(`::group::test/known.test.ts:
(fail) known failure [1.00ms]
::endgroup::

test/other.spec.ts:
(fail) other failure [2.00ms]

2 tests failed:
`);

  expect(failures).toEqual([
    { file: "test/known.test.ts", name: "known failure" },
    { file: "test/other.spec.ts", name: "other failure" }
  ]);
});

test("TUI test retries fail closed when Bun reports an unparsed failure", () => {
  const failures = parseFailures(`test/known.test.ts:
(fail) known failure [1.00ms]

future-test-format:
(fail) unparsed failure [2.00ms]

2 tests failed:
`);

  expect(failures).toBeNull();
});

test("TUI test retries use the shard when Bun omits a failure file", () => {
  const failures = parseFailures(`(fail) known failure [1.00ms]

1 test failed:
(fail) known failure [1.00ms]
`);

  expect(failures).toEqual([{ file: null, name: "known failure" }]);
});

test("TUI test retries ignore terminal formatting in Bun headings", () => {
  const failures = parseFailures(`\u001B[31m::group::test/known.test.ts:\u001B[0m
(fail) known failure [1.00ms]

1 test failed:
(fail) known failure [1.00ms]
`);

  expect(failures).toEqual([
    { file: "test/known.test.ts", name: "known failure" }
  ]);
});

test("TUI test retries fail closed when Bun also reports an unhandled error", () => {
  const failures = parseFailures(`test/known.test.ts:
(fail) transient failure [1.00ms]

# Unhandled error between tests
1 error

1 tests failed:
`);

  expect(failures).toBeNull();
});

test("TUI test retries find an unhandled error after the failed-test recap", () => {
  const failures = parseFailures(`test/known.test.ts:
(fail) transient failure [1.00ms]

1 test failed:
(fail) transient failure [1.00ms]

# Unhandled error after tests
1 error
`);

  expect(failures).toBeNull();
});
