import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFailures } from "./test-shard-failures.js";

// Bun 1.4 can retain worker state in a long test-runner session. Use a fresh
// process for each shard. Recheck named failures alone. Recheck process-level
// failures with the same shard because Bun gives them no test name.
const SHARD_COUNT = 16;
const ISOLATED_ATTEMPTS = 2;
const DEFAULT_TIMEOUT = "--timeout=30000";
const DEFAULT_CONCURRENCY = "--max-concurrency=1";
const tuiRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (import.meta.main) await main();

async function main(): Promise<void> {
  const requestedArgs = process.argv.slice(2);
  const testArgs = requestedArgs[0] === "--"
    ? requestedArgs.slice(1)
    : requestedArgs;

  if (testArgs.some((arg) => arg === "--shard" || arg.startsWith("--shard="))) {
    throw new Error("test-shards.ts selects the shard; do not pass --shard");
  }

  if (!testArgs.some((arg) => arg === "--timeout" || arg.startsWith("--timeout="))) {
    testArgs.push(DEFAULT_TIMEOUT);
  }
  if (!testArgs.some(
    (arg) => arg === "--max-concurrency" || arg.startsWith("--max-concurrency=")
  )) {
    testArgs.push(DEFAULT_CONCURRENCY);
  }

  const failedShards: number[] = [];

  for (let shard = 1; shard <= SHARD_COUNT; shard += 1) {
    process.stdout.write(`\n==> TUI test shard ${shard}/${SHARD_COUNT}\n`);
    const result = await runTestProcess([
      `--shard=${shard}/${SHARD_COUNT}`,
      ...testArgs
    ]);
    if (result.exitCode === 0) continue;

    const failures = parseFailures(result.stderr);
    if (failures === null || failures.length === 0) {
      const passed = await recheckWholeShard(shard, testArgs);
      if (!passed) failedShards.push(shard);
      continue;
    }

    process.stderr.write(
      `\nRechecking ${failures.length} failed test${failures.length === 1 ? "" : "s"} from shard ${shard}/${SHARD_COUNT} in fresh Bun processes.\n`
    );
    let isolatedFailure = false;
    for (const failure of failures) {
      const testName = failure.name.split(" > ").at(-1)!;
      let passed = false;
      for (let attempt = 1; attempt <= ISOLATED_ATTEMPTS; attempt += 1) {
        process.stdout.write(
          `\n==> Isolated retry ${attempt}/${ISOLATED_ATTEMPTS}: ${failure.file}: ${failure.name}\n`
        );
        const isolated = await runTestProcess([
          failure.file,
          `--test-name-pattern=${escapeRegex(testName)}`,
          ...withoutNamePattern(testArgs)
        ]);
        if (isolated.exitCode === 0) {
          passed = true;
          break;
        }
      }
      if (!passed) isolatedFailure = true;
    }
    if (isolatedFailure) failedShards.push(shard);
  }

  if (failedShards.length > 0) {
    process.stderr.write(`\nTUI test shards failed: ${failedShards.join(", ")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`\nAll ${SHARD_COUNT} TUI test shards passed.\n`);
  }
}

async function recheckWholeShard(
  shard: number,
  testArgs: readonly string[]
): Promise<boolean> {
  process.stderr.write(
    `\nRechecking shard ${shard}/${SHARD_COUNT} after an unparsed or process-level failure.\n`
  );
  for (let attempt = 1; attempt <= ISOLATED_ATTEMPTS; attempt += 1) {
    process.stdout.write(
      `\n==> Fresh shard retry ${attempt}/${ISOLATED_ATTEMPTS}: ${shard}/${SHARD_COUNT}\n`
    );
    const result = await runTestProcess([
      `--shard=${shard}/${SHARD_COUNT}`,
      ...testArgs
    ]);
    if (result.exitCode === 0) return true;
  }
  return false;
}

async function runTestProcess(args: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
}> {
  const child = Bun.spawn(
    [process.execPath, "test", ...args],
    {
      cwd: tuiRoot,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe"
    }
  );
  process.stdout.write(`    Bun process ${child.pid}\n`);
  const [stderr, exitCode] = await Promise.all([
    mirror(child.stderr, process.stderr),
    mirror(child.stdout, process.stdout).then(() => child.exited)
  ]);
  return { exitCode, stderr };
}

async function mirror(
  stream: ReadableStream<Uint8Array>,
  output: NodeJS.WriteStream
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output.write(value);
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function withoutNamePattern(args: readonly string[]): readonly string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--test-name-pattern") {
      index += 1;
    } else if (!arg.startsWith("--test-name-pattern=")) {
      filtered.push(arg);
    }
  }
  return filtered;
}
