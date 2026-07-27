import { expect, test } from "bun:test";
import { RELEASE_LAUNCHER_PACKAGE } from "../../shared/release-targets.js";
import { compareSemVer } from "../../shared/semver.js";
import {
  PLATFORM_PACKAGES,
  parseNpmExactVersionMetadata
} from "../src/npm-upgrade-registry.js";

const INTEGRITY = `sha512-${"A".repeat(86)}==`;

test("near-limit upgrade metadata parsing and SemVer selection stay inexpensive", () => {
  const graph = Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, "2.0.0"]));
  const body = JSON.stringify({
    name: RELEASE_LAUNCHER_PACKAGE,
    version: "2.0.0",
    dist: { integrity: INTEGRITY },
    optionalDependencies: graph,
    ignored: "x".repeat(60 * 1024)
  });

  const metadataStart = performance.now();
  for (let iteration = 0; iteration < 250; iteration += 1) {
    parseNpmExactVersionMetadata(body, {
      name: RELEASE_LAUNCHER_PACKAGE,
      version: "2.0.0",
      optionalDependencies: graph
    });
  }
  const metadataMs = performance.now() - metadataStart;

  const semverStart = performance.now();
  for (let iteration = 0; iteration < 20_000; iteration += 1) {
    compareSemVer("2.0.0-beta.11+candidate", "2.0.0-beta.2+prior");
  }
  const semverMs = performance.now() - semverStart;

  console.log(
    `upgrade performance — 250 near-limit metadata parses ${metadataMs.toFixed(1)}ms; `
    + `20k SemVer comparisons ${semverMs.toFixed(1)}ms`
  );
  expect(metadataMs).toBeLessThan(750);
  expect(semverMs).toBeLessThan(500);
});
