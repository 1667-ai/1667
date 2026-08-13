import { expect, test } from "bun:test";
import { releaseTargetForArtifact } from "../../shared/release-targets.js";
import {
  LAUNCHER_PACKAGE,
  NPM_METADATA_MAX_BYTES,
  NPM_VERSION_INDEX_MAX_BYTES,
  NpmUpgradeRegistry,
  PLATFORM_PACKAGES,
  parseNpmAvailableVersions,
  parseNpmDistTags,
  parseNpmExactVersionMetadata
} from "../src/npm-upgrade-registry.js";
import { UpgradeFailure } from "../src/upgrade-contract.js";

const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const PLATFORM_PACKAGE = releaseTargetForArtifact("linux-x64").packageName;
const DARWIN_PACKAGE = releaseTargetForArtifact("darwin-arm64").packageName;

function tarballUrl(packageName: string, version: string): string {
  const base = packageName.includes("/")
    ? packageName.slice(packageName.lastIndexOf("/") + 1)
    : packageName;
  // Real npm serves the scoped slash in the path, not percent-encoding.
  return `https://registry.npmjs.org/${packageName}/-/${base}-${version}.tgz`;
}

const TARBALL = tarballUrl(LAUNCHER_PACKAGE, "2.0.0");

test("npm package metadata lists non-deprecated releases newest first", () => {
  expect(parseNpmAvailableVersions(JSON.stringify({
    name: LAUNCHER_PACKAGE,
    versions: {
      "1.0.0": { name: LAUNCHER_PACKAGE, version: "1.0.0" },
      "1.1.0": { name: LAUNCHER_PACKAGE, version: "1.1.0", deprecated: "" },
      "2.0.0-rc.1": { name: LAUNCHER_PACKAGE, version: "2.0.0-rc.1" },
      "0.5.0": { name: LAUNCHER_PACKAGE, version: "0.5.0", revoked: true },
      "0.0.0": { name: LAUNCHER_PACKAGE, version: "0.0.0", deprecated: "reserved" },
      "2.0.0": { name: LAUNCHER_PACKAGE, version: "2.0.0" }
    }
  }))).toEqual(["2.0.0", "2.0.0-rc.1", "1.1.0", "1.0.0"]);
  expect(() => parseNpmAvailableVersions(JSON.stringify({
    name: LAUNCHER_PACKAGE,
    versions: { "1.0.0": { name: "foreign", version: "1.0.0" } }
  }))).toThrow();
});

test("npm dist tags select strict stable and beta channel heads", () => {
  const body = JSON.stringify({
    // A stale hand-set tag, as the registry holds today. Reading it would give
    // an installation a version two releases behind the stable channel head.
    stable: "1.0.0",
    beta: "2.1.0-beta.2",
    latest: "2.0.0",
    next_build: "2.1.0+build-1"
  });
  // A release writes `latest` and `beta`, and writes no dist-tag with the name
  // `stable`, so the stable channel reads `latest` and ignores that name.
  expect(parseNpmDistTags(body, "stable")).toBe("2.0.0");
  expect(parseNpmDistTags(body, "beta")).toBe("2.1.0-beta.2");
  expect(parseNpmDistTags(
    JSON.stringify({ latest: "2.0.0+build-1" }),
    "stable"
  )).toBe("2.0.0+build-1");
  expect(() => parseNpmDistTags(JSON.stringify({ stable: "2.0.0" }), "stable")).toThrow();
});

test("npm dist tags reject malformed, hostile, and over-bound metadata", () => {
  const bodies = [
    "",
    "[]",
    JSON.stringify({ latest: "v1.0.0" }),
    JSON.stringify({ latest: "1.0.0-beta.1" }),
    JSON.stringify({ latest: "1.0.0", "bad tag": "1.0.0" }),
    JSON.stringify({ latest: "1.0.0", beta: "1.0.0\u001b" }),
    '{"latest":"1.0.0","\\u006catest":"2.0.0"}',
    new Uint8Array(NPM_METADATA_MAX_BYTES + 1)
  ];
  for (const body of bodies) expect(() => parseNpmDistTags(body, "stable")).toThrow();
});

test("exact npm metadata validates identity, integrity, and the complete platform graph", () => {
  const optionalDependencies = Object.fromEntries(
    PLATFORM_PACKAGES.map((name) => [name, "2.0.0"])
  );
  const metadata = parseNpmExactVersionMetadata(JSON.stringify({
    name: LAUNCHER_PACKAGE,
    version: "2.0.0",
    dist: { integrity: INTEGRITY, tarball: TARBALL },
    optionalDependencies,
    unknown: "ignored"
  }), {
    name: LAUNCHER_PACKAGE,
    version: "2.0.0",
    launcherGraph: { requiredPlatformPackage: PLATFORM_PACKAGE }
  });
  expect(metadata).toEqual({
    name: LAUNCHER_PACKAGE,
    version: "2.0.0",
    integrity: INTEGRITY,
    tarball: TARBALL
  });
  expect(Object.isFrozen(metadata)).toBeTrue();
});

test("a launcher that names a platform this build never heard of still verifies", () => {
  // A release that publishes a new target names one more platform package than
  // the installed build knows. A build that refused this refused every later
  // release as well, and refused it inside itself, where no fix could reach it.
  const graph = Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, "2.0.0"]));
  const metadata = parseNpmExactVersionMetadata(JSON.stringify({
    name: LAUNCHER_PACKAGE,
    version: "2.0.0",
    dist: { integrity: INTEGRITY, tarball: TARBALL },
    optionalDependencies: { ...graph, "@1667-ai/freebsd-x64": "2.0.0" }
  }), {
    name: LAUNCHER_PACKAGE,
    version: "2.0.0",
    launcherGraph: { requiredPlatformPackage: PLATFORM_PACKAGE }
  });
  expect(metadata.version).toBe("2.0.0");
});

test("the launcher graph refuses a foreign package, a skewed pin, or a dropped platform", () => {
  const graph = Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, "2.0.0"]));
  const { [PLATFORM_PACKAGE]: _dropped, ...withoutOwnPlatform } = graph;
  for (const optionalDependencies of [
    // A package outside the release scope is never part of this graph.
    { ...graph, "surprise-runtime": "2.0.0" },
    { ...graph, "@other-scope/linux-x64": "2.0.0" },
    // A platform package pinned to another version is a graph this upgrade
    // did not verify.
    { ...graph, "@1667-ai/freebsd-x64": "2.0.1" },
    // The launcher cannot depend on itself.
    { ...graph, [LAUNCHER_PACKAGE]: "2.0.0" },
    // A release that no longer carries this installation's platform stops here.
    withoutOwnPlatform,
    {}
  ]) {
    expect(() => parseNpmExactVersionMetadata(JSON.stringify({
      name: LAUNCHER_PACKAGE,
      version: "2.0.0",
      dist: { integrity: INTEGRITY, tarball: TARBALL },
      optionalDependencies
    }), {
      name: LAUNCHER_PACKAGE,
      version: "2.0.0",
      launcherGraph: { requiredPlatformPackage: PLATFORM_PACKAGE }
    })).toThrow();
  }
});

test("exact npm metadata rejects deprecated targets and graph or identity drift", () => {
  const graph = Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, "2.0.0"]));
  const valid = {
    name: LAUNCHER_PACKAGE,
    version: "2.0.0",
    dist: { integrity: INTEGRITY, tarball: TARBALL },
    optionalDependencies: graph
  };
  const expected = {
    name: LAUNCHER_PACKAGE,
    version: "2.0.0",
    launcherGraph: { requiredPlatformPackage: PLATFORM_PACKAGE }
  };
  expect(parseNpmExactVersionMetadata(
    JSON.stringify({ ...valid, deprecated: "" }),
    expected
  ).version).toBe("2.0.0");
  for (const value of [
    { ...valid, name: "other" },
    { ...valid, deprecated: "bad release" },
    { ...valid, revoked: true },
    { ...valid, dist: {} },
    { ...valid, dependencies: { "surprise-runtime": "1.0.0" } },
    { ...valid, bundledDependencies: ["surprise-runtime"] },
    { ...valid, optionalDependencies: { ...graph, [PLATFORM_PACKAGE]: "2.0.1" } }
  ]) {
    expect(() => parseNpmExactVersionMetadata(JSON.stringify(value), expected)).toThrow();
  }
  expect(() => parseNpmExactVersionMetadata(
    `{"name":"${LAUNCHER_PACKAGE}","name":"other","version":"2.0.0","dist":{"integrity":"${INTEGRITY}","tarball":"${TARBALL}"},"optionalDependencies":${JSON.stringify(graph)}}`,
    expected
  )).toThrow();
});

test("registry client fixes the canonical origin and bounds streamed responses", async () => {
  const calls: string[] = [];
  const registry = new NpmUpgradeRegistry(async (input, init) => {
    calls.push(input);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    return Response.json({ latest: "2.0.0" });
  });
  expect(await registry.channelHead("stable", new AbortController().signal)).toBe("2.0.0");
  expect(calls).toEqual([
    "https://registry.npmjs.org/-/package/@1667-ai%2fcli/dist-tags"
  ]);

  const oversized = new NpmUpgradeRegistry(async () => new Response(
    new Uint8Array(NPM_METADATA_MAX_BYTES + 1),
    { headers: { "content-type": "application/json" } }
  ));
  const error = await rejection(oversized.channelHead("stable", new AbortController().signal));
  expect(error instanceof UpgradeFailure).toBeTrue();
  expect((error as UpgradeFailure).code).toBe("metadata_invalid");

  for (const response of [
    new Response('{"latest":"2.0.0"}', {
      headers: { "content-type": "text/plain" }
    }),
    new Response('{"latest":"2.0.0"}', {
      headers: {
        "content-type": "application/json",
        "content-length": String(NPM_METADATA_MAX_BYTES + 1)
      }
    })
  ]) {
    const invalid = new NpmUpgradeRegistry(async () => response);
    const invalidError = await rejection(
      invalid.channelHead("stable", new AbortController().signal)
    );
    expect((invalidError as UpgradeFailure).code).toBe("metadata_invalid");
  }
});

test("registry client requests the bounded abbreviated version index", async () => {
  const calls: Array<{ input: string; accept: string | null }> = [];
  const registry = new NpmUpgradeRegistry(async (input, init) => {
    calls.push({
      input,
      accept: new Headers(init.headers).get("accept")
    });
    return new Response(JSON.stringify({
      name: LAUNCHER_PACKAGE,
      versions: {
        "1.0.0": { name: LAUNCHER_PACKAGE, version: "1.0.0" },
        "1.1.0-rc.1": { name: LAUNCHER_PACKAGE, version: "1.1.0-rc.1" }
      }
    }), { headers: { "content-type": "application/vnd.npm.install-v1+json" } });
  });
  expect(await registry.availableVersions(new AbortController().signal))
    .toEqual(["1.1.0-rc.1", "1.0.0"]);
  expect(calls).toEqual([{
    input: "https://registry.npmjs.org/@1667-ai%2fcli",
    accept: "application/vnd.npm.install-v1+json"
  }]);

  const oversized = new NpmUpgradeRegistry(async () => new Response(
    new Uint8Array(NPM_VERSION_INDEX_MAX_BYTES + 1),
    { headers: { "content-type": "application/vnd.npm.install-v1+json" } }
  ));
  const error = await rejection(
    oversized.availableVersions(new AbortController().signal)
  );
  expect((error as UpgradeFailure).code).toBe("metadata_invalid");
});

test("registry client derives exact launcher and platform endpoints locally", async () => {
  const calls: string[] = [];
  const graph = Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, "2.0.0+build.1"]));
  const registry = new NpmUpgradeRegistry(async (input) => {
    calls.push(input);
    const packageName = input.includes("linux-x64")
      ? PLATFORM_PACKAGE
      : LAUNCHER_PACKAGE;
    return Response.json({
      name: packageName,
      version: "2.0.0+build.1",
      dist: { integrity: INTEGRITY, tarball: tarballUrl(packageName, "2.0.0+build.1") },
      ...(packageName === LAUNCHER_PACKAGE
        ? { optionalDependencies: graph }
        : { os: ["linux"], cpu: ["x64"], libc: ["glibc"] })
    });
  });
  const signal = new AbortController().signal;
  await registry.launcher("2.0.0+build.1", PLATFORM_PACKAGE, signal);
  await registry.platform(PLATFORM_PACKAGE, "2.0.0+build.1", signal);
  expect(calls).toEqual([
    "https://registry.npmjs.org/@1667-ai%2fcli/2.0.0%2Bbuild.1",
    "https://registry.npmjs.org/@1667-ai%2flinux-x64/2.0.0%2Bbuild.1"
  ]);
});

test("registry client rejects incomplete or drifting platform identity", async () => {
  for (const identity of [
    { os: ["darwin"], cpu: ["x64"], libc: ["glibc"] },
    { os: ["linux"], cpu: ["arm64"], libc: ["glibc"] },
    { os: ["linux"], libc: ["glibc"] },
    { cpu: ["x64"], libc: ["glibc"] }
  ]) {
    const registry = new NpmUpgradeRegistry(async () => Response.json({
      name: PLATFORM_PACKAGE,
      version: "2.0.0",
      dist: { integrity: INTEGRITY, tarball: tarballUrl(PLATFORM_PACKAGE, "2.0.0") },
      ...identity
    }));
    const error = await rejection(
      registry.platform(PLATFORM_PACKAGE, "2.0.0", new AbortController().signal)
    );
    expect((error as UpgradeFailure).code).toBe("verification_failed");
  }
});

test("registry client rejects Linux metadata that omits libc", async () => {
  const registry = platformRegistry(PLATFORM_PACKAGE, {
    os: ["linux"],
    cpu: ["x64"]
  });
  const error = await rejection(
    registry.platform(PLATFORM_PACKAGE, "2.0.0", new AbortController().signal)
  );
  expect((error as UpgradeFailure).code).toBe("verification_failed");
});

test("registry client rejects Linux metadata with a non-glibc libc", async () => {
  for (const libc of [["musl"], ["other"]]) {
    const registry = platformRegistry(PLATFORM_PACKAGE, {
      os: ["linux"],
      cpu: ["x64"],
      libc
    });
    const error = await rejection(
      registry.platform(PLATFORM_PACKAGE, "2.0.0", new AbortController().signal)
    );
    expect((error as UpgradeFailure).code).toBe("verification_failed");
  }
});

test("registry client rejects libc metadata on a Darwin package", async () => {
  const registry = platformRegistry(DARWIN_PACKAGE, {
    os: ["darwin"],
    cpu: ["arm64"],
    libc: ["glibc"]
  });
  const error = await rejection(
    registry.platform(DARWIN_PACKAGE, "2.0.0", new AbortController().signal)
  );
  expect((error as UpgradeFailure).code).toBe("verification_failed");
});

test("registry client rejects libc metadata on the launcher package", async () => {
  const graph = Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, "2.0.0"]));
  const registry = new NpmUpgradeRegistry(async () => Response.json({
    name: LAUNCHER_PACKAGE,
    version: "2.0.0",
    dist: { integrity: INTEGRITY, tarball: TARBALL },
    optionalDependencies: graph,
    libc: ["glibc"]
  }));
  const error = await rejection(
    registry.launcher("2.0.0", PLATFORM_PACKAGE, new AbortController().signal)
  );
  expect((error as UpgradeFailure).code).toBe("verification_failed");
});

test("registry client classifies aborts, missing targets, and retryable failures", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = new NpmUpgradeRegistry(async (_input, init) => {
    throw init.signal instanceof AbortSignal && init.signal.aborted
      ? new DOMException("aborted", "AbortError")
      : new Error("unexpected");
  });
  expect(((await rejection(aborted.channelHead("stable", controller.signal))) as UpgradeFailure).code)
    .toBe("interrupted");

  const missing = new NpmUpgradeRegistry(async () => new Response(null, { status: 404 }));
  expect(((await rejection(missing.channelHead("stable", new AbortController().signal))) as UpgradeFailure).code)
    .toBe("unsupported_target");

  const busy = new NpmUpgradeRegistry(async () => new Response(null, { status: 503 }));
  const busyError = await rejection(busy.channelHead("stable", new AbortController().signal));
  expect((busyError as UpgradeFailure).code).toBe("network_error");
  expect((busyError as UpgradeFailure).retryable).toBeTrue();
});

test("registry timeout is a retryable network failure", async () => {
  const stalledFetch = new NpmUpgradeRegistry((_input, init) => new Promise((_resolve, reject) => {
    const signal = init.signal as AbortSignal;
    const abort = () => reject(new DOMException("timed out", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }), 1);
  const stalledBody = new NpmUpgradeRegistry(async (_input, init) => {
    const signal = init.signal as AbortSignal;
    return new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), {
          once: true
        });
      }
    }), { headers: { "content-type": "application/json" } });
  }, 1);
  for (const registry of [stalledFetch, stalledBody]) {
    const error = await rejection(
      registry.channelHead("stable", new AbortController().signal)
    );
    expect((error as UpgradeFailure).code).toBe("network_error");
    expect((error as UpgradeFailure).retryable).toBeTrue();
  }
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

function platformRegistry(
  packageName: string,
  identity: Record<string, unknown>
): NpmUpgradeRegistry {
  return new NpmUpgradeRegistry(async () => Response.json({
    name: packageName,
    version: "2.0.0",
    dist: { integrity: INTEGRITY, tarball: tarballUrl(packageName, "2.0.0") },
    ...identity
  }));
}
