import { describe, expect, test } from "bun:test";
import { RELEASE_LAUNCHER_PACKAGE } from "../../shared/release-targets.js";
import {
  UPDATE_CACHE_TTL_MS,
  createUpdateCacheEntry,
  encodeUpdateCache,
  readUpdateCacheHint,
  updateCacheFingerprint,
  updateFailureDelayMs,
  type UpdateCacheKey
} from "../src/update-cache.js";

const key: UpdateCacheKey = {
  metadataKind: "npm",
  metadataOrigin: "https://registry.npmjs.org",
  packageName: RELEASE_LAUNCHER_PACKAGE,
  installIdentity: "manual:source:0.1.0",
  currentVersion: "0.1.0",
  artifactTarget: "source",
  channel: "stable",
  prereleasePolicy: "stable-only"
};

describe("notification-only update cache", () => {
  test("hits only for the complete identity within 24 hours", () => {
    const checkedAt = 100_000;
    const entry = createUpdateCacheEntry(key, "0.2.0", checkedAt);
    const bytes = encodeUpdateCache(entry);
    expect(readUpdateCacheHint(bytes, key, checkedAt + UPDATE_CACHE_TTL_MS)?.latest).toBe("0.2.0");
    expect(readUpdateCacheHint(bytes, key, checkedAt + UPDATE_CACHE_TTL_MS + 1)).toBe(null);

    for (const changed of [
      { ...key, channel: "beta" as const },
      { ...key, currentVersion: "0.1.1" },
      { ...key, installIdentity: "npm:different" },
      { ...key, artifactTarget: "linux-x64" },
      { ...key, metadataOrigin: "https://registry.example.invalid" },
      { ...key, prereleasePolicy: "allow-prerelease" as const }
    ]) {
      expect(readUpdateCacheHint(bytes, changed, checkedAt + 1)).toBe(null);
    }
  });

  test("malformed, oversized, future, and schema-drifted cache bytes are misses", () => {
    const entry = createUpdateCacheEntry(key, "0.2.0", 1_000);
    const cases = [
      new TextEncoder().encode("{"),
      new Uint8Array(8 * 1024 + 1),
      new TextEncoder().encode(JSON.stringify({ ...entry, extra: true })),
      new TextEncoder().encode(JSON.stringify({ ...entry, latest: "latest" })),
      new TextEncoder().encode(JSON.stringify({ ...entry, fingerprint: "0".repeat(64) })),
      new TextEncoder().encode(
        `{"schemaVersion":1,"schemaVersion":1,"fingerprint":"${entry.fingerprint}",`
        + `"checkedAt":1000,"latest":"0.2.0"}`
      )
    ];
    for (const bytes of cases) expect(readUpdateCacheHint(bytes, key, 1_001)).toBe(null);
    expect(readUpdateCacheHint(encodeUpdateCache(entry), key, 999)).toBe(null);
  });

  test("fingerprints are stable and exclude reusable authority", () => {
    expect(updateCacheFingerprint(key)).toBe(updateCacheFingerprint({ ...key }));
    const encoded = new TextDecoder().decode(encodeUpdateCache(createUpdateCacheEntry(key, "0.2.0", 1)));
    expect(encoded).not.toContain(key.installIdentity);
    expect(encoded).not.toContain("command");
    expect(encoded).not.toContain("argv");
  });

  test("failure backoff is bounded exponential jitter", () => {
    expect(updateFailureDelayMs(0, 0)).toBe(3_750);
    expect(updateFailureDelayMs(0, 1)).toBe(6_250);
    expect(updateFailureDelayMs(1, 0)).toBe(7_500);
    expect(updateFailureDelayMs(99, 1) <= 60 * 60 * 1_000 * 1.25).toBeTrue();
  });
});
