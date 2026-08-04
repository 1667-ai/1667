import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { readOptionalPrivateFile } from "../server/private-file-publication.js";

// `publishPrivateFileNoReplace` never blocks on anything external, so a
// SIGSTOPped writer is exactly a *healthy* writer the OS has not scheduled --
// cgroup CPU throttling, a loaded host, a paused VM, or a slow `fsync` all
// leave the identical on-disk state. `fsync` has no upper bound, so no
// timeout can tell "slow" apart from "gone"; only a real signal (the process
// is simply not running) can. These tests freeze an unmodified writer with
// SIGSTOP mid-publish, in both the pre-link and the post-link window, and
// prove a concurrent recovery pass never removes its scratch.
const POLICY = { label: "frozen-writer fixture file", maxBytes: 4096 };
const SCRATCH_SUFFIX = ".1667-publish-v1.tmp";
const FIXTURE = fileURLToPath(
  new URL("./private-file-publication-writer-fixture.ts", import.meta.url)
);
const WINDOW_SEARCH_DEADLINE_MS = 5_000;
const ROUND_ATTEMPTS = 20;

interface WriterOutcome {
  readonly outcome: "published" | "failed";
  readonly code?: string | null;
  readonly message?: string;
}

test(
  "recovery leaves a frozen-but-healthy writer's pre-link scratch alone",
  { skip: process.platform === "win32" ? "SIGSTOP is POSIX-only" : false },
  async (t) => {
    const result = await runFrozenWriterRound(t, "pre-link", (scratch, file) =>
      existsSync(scratch) && !existsSync(file));
    assert.equal(
      result.writer.outcome,
      "published",
      `a frozen pre-link writer must still publish once resumed: ${JSON.stringify(result.writer)}`
    );
    assert.equal(
      result.scratchRemovedWhileFrozen,
      false,
      "recovery must not remove a live writer's pre-link scratch"
    );
  }
);

test(
  "recovery leaves a frozen-but-healthy writer's post-link scratch alone",
  { skip: process.platform === "win32" ? "SIGSTOP is POSIX-only" : false },
  async (t) => {
    const result = await runFrozenWriterRound(t, "post-link", (scratch, file) =>
      existsSync(scratch) && existsSync(file) && statSync(file).nlink === 2);
    assert.equal(
      result.writer.outcome,
      "published",
      `a frozen post-link writer must still publish once resumed: ${JSON.stringify(result.writer)}`
    );
    assert.equal(
      result.scratchRemovedWhileFrozen,
      false,
      "recovery must not remove a live writer's post-link scratch before the writer's own cleanup"
    );
  }
);

interface FrozenWriterRoundResult {
  readonly writer: WriterOutcome;
  readonly scratchRemovedWhileFrozen: boolean;
}

/**
 * Fork the fixture, busy-poll for the requested on-disk window, freeze the
 * writer there with SIGSTOP, run one ordinary concurrent read, then resume
 * and collect the writer's own outcome. Missing the window (the writer ran
 * ahead of the poll) retries with a fresh process rather than asserting
 * anything -- that is a scheduling miss, not evidence either way.
 */
async function runFrozenWriterRound(
  t: TestContext,
  label: string,
  isTargetWindow: (scratch: string, file: string) => boolean
): Promise<FrozenWriterRoundResult> {
  for (let attempt = 0; attempt < ROUND_ATTEMPTS; attempt += 1) {
    const dir = await temporaryDirectory(t, `1667-frozen-writer-${label}-`);
    const file = path.join(dir, "reserved.bin");
    const scratch = `${file}${SCRATCH_SUFFIX}`;

    const child = fork(FIXTURE, [file], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    const writerDone = collectWriterOutcome(child);

    if (!freezeAtWindow(child, scratch, file, isTargetWindow)) {
      child.kill("SIGKILL");
      await writerDone;
      continue;
    }

    const scratchBeforeRead = existsSync(scratch);
    try {
      await readOptionalPrivateFile(file, POLICY);
    } catch {
      // A read that lands on a genuinely frozen (not merely slow) writer may
      // still fail closed -- an accepted, narrower flake this fix does not
      // eliminate. The property under test is scratch survival, checked next
      // regardless of whether the read above threw.
    }
    const scratchRemovedWhileFrozen = scratchBeforeRead && !existsSync(scratch);

    child.kill("SIGCONT");
    const writer = await writerDone;
    return { writer, scratchRemovedWhileFrozen };
  }
  throw new Error(`never caught the ${label} window in ${ROUND_ATTEMPTS} attempts`);
}

function freezeAtWindow(
  child: ChildProcess,
  scratch: string,
  file: string,
  isTargetWindow: (scratch: string, file: string) => boolean
): boolean {
  const deadline = Date.now() + WINDOW_SEARCH_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (isTargetWindow(scratch, file)) {
      child.kill("SIGSTOP");
      return true;
    }
    // The writer finished (and cleaned up) before this poll ever saw the
    // requested window -- too fast to catch this round.
    if (existsSync(file) && !existsSync(scratch)) return false;
  }
  return false;
}

function collectWriterOutcome(child: ChildProcess): Promise<WriterOutcome> {
  return new Promise((resolve) => {
    let outcome: WriterOutcome | undefined;
    child.on("message", (message: WriterOutcome & { ready?: boolean }) => {
      if ("ready" in message) return;
      outcome = message;
    });
    child.on("exit", () => {
      resolve(outcome ?? { outcome: "failed", message: "no outcome reported" });
    });
  });
}

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
