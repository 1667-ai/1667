import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const RUNBOOK = await readFile(
  new URL("../docs/npm-release-operations.md", import.meta.url),
  "utf8"
);
const RECOVERY = await readFile(
  new URL("../docs/npm-operation-lease-recovery.md", import.meta.url),
  "utf8"
);
const CONTROLS = await readFile(
  new URL("../docs/npm-release-operation-controls.md", import.meta.url),
  "utf8"
);

test("operation runbook shell blocks parse as Bash", () => {
  const blocks = [...`${RUNBOOK}\n${RECOVERY}\n${CONTROLS}`.matchAll(
    /```sh\n([\s\S]*?)\n```/gu
  )];
  assert.ok(blocks.length > 0);
  for (const [index, match] of blocks.entries()) {
    const result = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: match[1] ?? ""
    });
    assert.equal(
      result.status,
      0,
      `runbook shell block ${index + 1} is invalid:\n${result.stderr}`
    );
  }
});

test("runbooks invoke typed acquisition, stop, and recovery commands", () => {
  assert.match(
    RECOVERY,
    /release-npm-operation-orchestration-cli\.ts \\\n    acquire/u
  );
  assert.match(RUNBOOK, /npm run release:operation -- stop-active/u);
  assert.match(RECOVERY, /npm run release:operation -- recover/u);
});

test("runbooks do not contain executable lease state machines", () => {
  assert.doesNotMatch(RUNBOOK, /while :|gh api --paginate|OPEN_STATE_JSON/u);
  assert.doesNotMatch(RECOVERY, /while :|gh run list|LEASE_HOLD_JOBS/u);
  assert.doesNotMatch(
    RECOVERY,
    /release-npm-operation-lease-cli\.ts \\\n\s+(?:claim|revoke|abandoned)/u
  );
});

test("acquisition keeps claim authority in the current shell", () => {
  assert.match(RECOVERY, /eval "\$\(\n  node --import tsx/u);
  assert.match(RECOVERY, /exports `NPM_OPERATION_CLAIM_SECRET`/u);
  assert.match(RECOVERY, /Do not write the authority to a file/u);
});

test("runbooks describe bounded and paginated orchestration", () => {
  assert.match(RECOVERY, /bounded polling/u);
  assert.match(RECOVERY, /scans all workflow run pages/u);
  assert.match(RUNBOOK, /scans all pages of publication runs first/u);
  assert.match(RUNBOOK, /bounded polling until all publication runs are terminal/u);
});

test("recovery preserves cancellation and settlement order", () => {
  const cancel = RECOVERY.indexOf("cancels the holder before");
  const revoke = RECOVERY.indexOf("revokes a writer", cancel);
  const firstProof = RECOVERY.indexOf("proves process quiescence", revoke);
  const repeat = RECOVERY.indexOf("repeats the proof after ten minutes", firstProof);
  const reconcile = RECOVERY.indexOf("reconciles the journal", repeat);
  assert.ok(
    cancel !== -1 && cancel < revoke && revoke < firstProof
      && firstProof < repeat && repeat < reconcile
  );
});

test("promotion runbook verifies durable assets before tag writes", () => {
  const section = RUNBOOK.slice(
    RUNBOOK.indexOf("## Promotion"),
    RUNBOOK.indexOf("## Quarantine")
  );
  const immutable = section.indexOf("isImmutable");
  const download = section.indexOf("gh release download");
  const assets = section.indexOf("verify-assets");
  const verify = section.indexOf("npm run release:publish -- verify");
  const promote = section.indexOf("npm run release:tags -- promote");
  assert.ok(
    immutable !== -1 && immutable < download && download < assets
      && assets < verify && verify < promote
  );
});

test("quarantine stops active work before it takes the lease", () => {
  const quarantine = RUNBOOK.indexOf("## Quarantine");
  const stop = RUNBOOK.indexOf("npm run release:operation -- stop-active", quarantine);
  const acquire = RUNBOOK.indexOf("### Acquire the quarantine lease", stop);
  const marker = RUNBOOK.indexOf("quarantine-marker", acquire);
  const write = RUNBOOK.indexOf("npm run release:tags -- quarantine", marker);
  assert.ok(
    quarantine !== -1 && quarantine < stop && stop < acquire
      && acquire < marker && marker < write
  );
});

test("quarantine documents holder cancellation before writer revocation", () => {
  const stop = RUNBOOK.indexOf("### Stop active npm operations");
  const holder = RUNBOOK.indexOf(
    "manual operation runs are terminal",
    stop
  );
  const writer = RUNBOOK.indexOf(
    "revokes an active writer only after the holder is terminal",
    holder
  );
  assert.ok(stop !== -1 && stop < holder && holder < writer);
  assert.doesNotMatch(
    RUNBOOK.slice(stop, RUNBOOK.indexOf("### Acquire", stop)),
    /revokes an active writer before it cancels/u
  );
});

test("release documentation identifies the authorize job boundary", async () => {
  const releasing = await readFile(
    new URL("../docs/RELEASING.md", import.meta.url),
    "utf8"
  );
  const authorize = releasing.indexOf("The `authorize` job runs");
  const branch = releasing.indexOf(
    "verifies the default branch",
    authorize
  );
  const release = releasing.indexOf("verifies the requested release", branch);
  const administrator = releasing.indexOf(
    "dispatcher to be a repository administrator",
    release
  );
  const hold = releasing.indexOf(
    "The `hold` job enters the shared lock",
    administrator
  );
  assert.ok(
    authorize !== -1 && authorize < branch && branch < release
      && release < administrator && administrator < hold
  );
});
