import { expect, test } from "bun:test";
import {
  CONSOLE_REPORT,
  assertWithinBudget,
  budgetTimeout,
  cpuBudget,
  startTiming
} from "../../test/performance-budget.js";
import { RELEASE_LAUNCHER_PACKAGE } from "../../shared/release-targets.js";
import { compareSemVer } from "../../shared/semver.js";
import {
  PLATFORM_PACKAGES,
  parseNpmExactVersionMetadata
} from "../src/npm-upgrade-registry.js";

const METADATA_BUDGET = cpuBudget(750);
const SEMVER_BUDGET = cpuBudget(500);

const INTEGRITY = `sha512-${"A".repeat(86)}==`;

test("near-limit upgrade metadata parsing and SemVer selection stay inexpensive", () => {
  const graph = Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, "2.0.0"]));
  const body = JSON.stringify({
    name: RELEASE_LAUNCHER_PACKAGE,
    version: "2.0.0",
    dist: {
      integrity: INTEGRITY,
      tarball: `https://registry.npmjs.org/${RELEASE_LAUNCHER_PACKAGE}/-/cli-2.0.0.tgz`
    },
    optionalDependencies: graph,
    ignored: "x".repeat(60 * 1024)
  });

  const readMetadata = startTiming();
  for (let iteration = 0; iteration < 250; iteration += 1) {
    parseNpmExactVersionMetadata(body, {
      name: RELEASE_LAUNCHER_PACKAGE,
      version: "2.0.0",
      optionalDependencies: graph
    });
  }
  const metadataTiming = readMetadata();

  const readSemver = startTiming();
  for (let iteration = 0; iteration < 20_000; iteration += 1) {
    compareSemVer("2.0.0-beta.11+candidate", "2.0.0-beta.2+prior");
  }
  const semverTiming = readSemver();

  assertWithinBudget(CONSOLE_REPORT, "250 near-limit metadata parses", METADATA_BUDGET, metadataTiming);
  assertWithinBudget(CONSOLE_REPORT, "20k SemVer comparisons", SEMVER_BUDGET, semverTiming);
// Bun applies a 5s default timeout, which is below the allowance these budgets need.
}, budgetTimeout([METADATA_BUDGET, SEMVER_BUDGET]));
