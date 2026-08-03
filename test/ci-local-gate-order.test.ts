import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Contract test on the script text, not an execution test: a real run needs
// Docker and a network-reachable package registry, which this suite must not
// depend on. See test/release-install-script-strict.test.ts for the same
// read-the-script-and-check-order approach applied to the install script.

test("Linux container setup installs tui's bun dependencies before any gate runs npm test", async () => {
  const source = await readFile(
    path.resolve("scripts/ci-local.sh"),
    "utf8"
  );

  const setup = extractFunctionBody(source, "ensure_container");
  const npmCiAt = setup.indexOf("npm ci");
  const bunInstallAt = setup.indexOf("cd tui && bun install");
  const userAddAt = setup.indexOf("useradd");
  assert.ok(npmCiAt >= 0, "container setup installs root npm dependencies");
  assert.ok(
    bunInstallAt > npmCiAt,
    "tui bun dependencies install after root npm dependencies"
  );
  assert.ok(
    userAddAt > bunInstallAt,
    "tui bun dependencies install before the container drops root"
  );

  // The regression this guards against: root npm test spawns
  // tui/src/standalone.ts (see test/character-card-import.test.ts and
  // test/story-novelai-import-integration.test.ts), which needs
  // @opentui/core from tui/node_modules. That module only exists once tui's
  // bun dependencies are installed, so the test gate must never run before
  // that install, in either the container setup or the per-target run.
  const run = extractFunctionBody(source, "run_linux");
  const ensureContainerCallAt = run.indexOf('ensure_container "$platform" "$name"');
  const runtimeTestAt = run.indexOf("${runtime_test}");
  assert.ok(ensureContainerCallAt >= 0, "run_linux calls ensure_container");
  assert.ok(runtimeTestAt >= 0, "run_linux invokes the npm test gate");
  assert.ok(
    ensureContainerCallAt < runtimeTestAt,
    "run_linux calls ensure_container before running the npm test gate, " +
      "so tui/node_modules exists before the gate can run"
  );
  assert.equal(
    run.indexOf("bun install"),
    -1,
    "run_linux must not install tui dependencies itself: that would let " +
      "npm test run before tui/node_modules exists"
  );
});

test("run_linux removes the named container when ensure_container fails, unless --keep is active", async () => {
  const source = await readFile(
    path.resolve("scripts/ci-local.sh"),
    "utf8"
  );

  // The regression this guards against: moving the tui bun install into
  // ensure_container (above) gave container setup a failure route that
  // returns before the normal end-of-run cleanup on line ~148 ever runs.
  // Without its own cleanup, a setup failure would leak the named container.
  const run = extractFunctionBody(source, "run_linux");
  const guardAt = run.indexOf('if ! ensure_container "$platform" "$name"; then');
  assert.ok(guardAt >= 0, "run_linux guards on ensure_container failure");
  const guardEnd = run.indexOf("\n  fi\n", guardAt);
  assert.ok(guardEnd >= 0, "the ensure_container failure guard closes with fi");
  const failureBlock = run.slice(guardAt, guardEnd);

  assert.match(
    failureBlock,
    /\[ "\$KEEP_CONTAINER" -eq 1 \] \|\| docker rm -f "\$name"/,
    "on setup failure, the container is removed unless --keep is active"
  );
});

function extractFunctionBody(source: string, name: string): string {
  const header = `${name}() {\n`;
  const start = source.indexOf(header);
  assert.ok(start >= 0, `scripts/ci-local.sh defines ${name}()`);
  const bodyStart = start + header.length;
  const end = source.indexOf("\n}\n", bodyStart);
  assert.ok(end >= 0, `${name}() has a closing brace`);
  return source.slice(bodyStart, end);
}
