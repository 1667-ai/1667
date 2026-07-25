import { expect, test } from "bun:test";
import {
  LAUNCHER_PACKAGE,
  NPM_METADATA_MAX_BYTES,
  NpmUpgradeRegistry,
  PLATFORM_PACKAGES,
  parseNpmDistTags,
  parseNpmExactVersionMetadata
} from "../src/npm-upgrade-registry.js";
import { UpgradeFailure } from "../src/upgrade-contract.js";

const INTEGRITY = `sha512-${"A".repeat(86)}==`;

test("npm dist tags select strict stable and beta channel heads", () => {
  const body = JSON.stringify({
    stable: "2.0.0",
    beta: "2.1.0-beta.2",
    latest: "2.0.0",
    next_build: "2.1.0+build-1"
  });
  expect(parseNpmDistTags(body, "stable")).toBe("2.0.0");
  expect(parseNpmDistTags(body, "beta")).toBe("2.1.0-beta.2");
  expect(parseNpmDistTags(
    JSON.stringify({ stable: "2.0.0+build-1" }),
    "stable"
  )).toBe("2.0.0+build-1");
});

test("npm dist tags reject malformed, hostile, and over-bound metadata", () => {
  const bodies = [
    "",
    "[]",
    JSON.stringify({ stable: "v1.0.0" }),
    JSON.stringify({ stable: "1.0.0-beta.1" }),
    JSON.stringify({ stable: "1.0.0", "bad tag": "1.0.0" }),
    JSON.stringify({ stable: "1.0.0", beta: "1.0.0\u001b" }),
    '{"stable":"1.0.0","\\u0073table":"2.0.0"}',
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
    dist: { integrity: INTEGRITY, tarball: "https://untrusted.invalid/archive.tgz" },
    optionalDependencies,
    unknown: "ignored"
  }), {
    name: LAUNCHER_PACKAGE,
    version: "2.0.0",
    optionalDependencies
  });
  expect(metadata).toEqual({ name: "1667", version: "2.0.0", integrity: INTEGRITY });
  expect(Object.isFrozen(metadata)).toBeTrue();
});

test("exact npm metadata rejects deprecated targets and graph or identity drift", () => {
  const graph = Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, "2.0.0"]));
  const valid = {
    name: "1667",
    version: "2.0.0",
    dist: { integrity: INTEGRITY },
    optionalDependencies: graph
  };
  const expected = { name: "1667", version: "2.0.0", optionalDependencies: graph };
  for (const value of [
    { ...valid, name: "other" },
    { ...valid, deprecated: "bad release" },
    { ...valid, revoked: true },
    { ...valid, dist: {} },
    { ...valid, dependencies: { "surprise-runtime": "1.0.0" } },
    { ...valid, bundledDependencies: ["surprise-runtime"] },
    { ...valid, optionalDependencies: { ...graph, "1667-linux-x64": "2.0.1" } }
  ]) {
    expect(() => parseNpmExactVersionMetadata(JSON.stringify(value), expected)).toThrow();
  }
  expect(() => parseNpmExactVersionMetadata(
    `{"name":"1667","name":"other","version":"2.0.0","dist":{"integrity":"${INTEGRITY}"},"optionalDependencies":${JSON.stringify(graph)}}`,
    expected
  )).toThrow();
});

test("registry client fixes the canonical origin and bounds streamed responses", async () => {
  const calls: string[] = [];
  const registry = new NpmUpgradeRegistry(async (input, init) => {
    calls.push(input);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    return Response.json({ stable: "2.0.0" });
  });
  expect(await registry.channelHead("stable", new AbortController().signal)).toBe("2.0.0");
  expect(calls).toEqual(["https://registry.npmjs.org/-/package/1667/dist-tags"]);

  const oversized = new NpmUpgradeRegistry(async () => new Response(
    new Uint8Array(NPM_METADATA_MAX_BYTES + 1),
    { headers: { "content-type": "application/json" } }
  ));
  const error = await rejection(oversized.channelHead("stable", new AbortController().signal));
  expect(error instanceof UpgradeFailure).toBeTrue();
  expect((error as UpgradeFailure).code).toBe("metadata_invalid");

  for (const response of [
    new Response('{"stable":"2.0.0"}', {
      headers: { "content-type": "text/plain" }
    }),
    new Response('{"stable":"2.0.0"}', {
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

test("registry client derives exact launcher and platform endpoints locally", async () => {
  const calls: string[] = [];
  const graph = Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, "2.0.0+build.1"]));
  const registry = new NpmUpgradeRegistry(async (input) => {
    calls.push(input);
    const packageName = input.includes("1667-linux-x64") ? "1667-linux-x64" : "1667";
    return Response.json({
      name: packageName,
      version: "2.0.0+build.1",
      dist: { integrity: INTEGRITY },
      ...(packageName === "1667"
        ? { optionalDependencies: graph }
        : { os: ["linux"], cpu: ["x64"] })
    });
  });
  const signal = new AbortController().signal;
  await registry.launcher("2.0.0+build.1", signal);
  await registry.platform("1667-linux-x64", "2.0.0+build.1", signal);
  expect(calls).toEqual([
    "https://registry.npmjs.org/1667/2.0.0%2Bbuild.1",
    "https://registry.npmjs.org/1667-linux-x64/2.0.0%2Bbuild.1"
  ]);
});

test("registry client rejects incomplete or drifting platform identity", async () => {
  for (const identity of [
    { os: ["darwin"], cpu: ["x64"] },
    { os: ["linux"], cpu: ["arm64"] },
    { os: ["linux"] },
    { cpu: ["x64"] }
  ]) {
    const registry = new NpmUpgradeRegistry(async () => Response.json({
      name: "1667-linux-x64",
      version: "2.0.0",
      dist: { integrity: INTEGRITY },
      ...identity
    }));
    const error = await rejection(
      registry.platform("1667-linux-x64", "2.0.0", new AbortController().signal)
    );
    expect((error as UpgradeFailure).code).toBe("verification_failed");
  }
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
  const registry = new NpmUpgradeRegistry((_input, init) => new Promise((_resolve, reject) => {
    const signal = init.signal as AbortSignal;
    const abort = () => reject(new DOMException("timed out", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }), 1);
  const error = await rejection(registry.channelHead("stable", new AbortController().signal));
  expect((error as UpgradeFailure).code).toBe("network_error");
  expect((error as UpgradeFailure).retryable).toBeTrue();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}
