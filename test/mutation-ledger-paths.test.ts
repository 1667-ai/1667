import assert from "node:assert/strict";
import test from "node:test";
import {
  PORTABLE_PATH_SEGMENT_BYTES,
  formatMigrationLedgerSegments,
  parseMutationLedgerSegments,
  storyLedgerToken,
  userMutationLedgerSegments
} from "../server/mutation-ledger-paths.js";
import { MutationLedgerFormatError } from "../server/mutation-ledger-scalars.js";

const MUTATION = `m1.1767225600000.${"d".repeat(32)}`;
const FM1 = `fm1:${"A".repeat(43)}`;

test("story ledger paths use fixed domain-separated token/day/shard vectors", () => {
  assert.equal(storyLedgerToken("story-one"), "h1-012fd2becc42101469c8280eedcdda39192412b938540b93926048e3e1b345c1");
  const segments = userMutationLedgerSegments("story:story-one", MUTATION);
  assert.deepEqual(segments, [
    "stories",
    "h1-012fd2becc42101469c8280eedcdda39192412b938540b93926048e3e1b345c1",
    "user",
    "20260101",
    "7f",
    MUTATION
  ]);
  assert.deepEqual(parseMutationLedgerSegments(segments, "story:story-one"), {
    kind: "user",
    aggregateKey: "story:story-one",
    mutationId: MUTATION,
    segments
  });
});

test("Windows device names and 255-character legacy IDs never enter physical paths", () => {
  const vectors = {
    CON: "h1-8a68ef9c5ff25f391ffb2d0eb5416b2f4fd09513b93115425dc76bb6b89d1c6f",
    NUL: "h1-bb079f6a8b98445231184a5db8fc7c4a5951b327bc8838b201fa846b4f85e270",
    COM1: "h1-a8123b4c9e683bbe260d2c224b90e3f888e0e937a3f8476e26ee8c1d317fa6aa"
  } as const;
  for (const [storyId, token] of Object.entries(vectors)) {
    assert.equal(storyLedgerToken(storyId), token);
    const segments = userMutationLedgerSegments(`story:${storyId}`, MUTATION);
    assert.equal(segments[1], token);
    assert.ok(!segments.includes(storyId));
  }
  const maxId = "a".repeat(255);
  const maxSegments = userMutationLedgerSegments(`story:${maxId}`, MUTATION);
  assert.equal(maxSegments[1], "h1-9a01c8db15af4da779e607fa6501fcda4021b72dd013bc6804bedf80d2e411b1");
  for (const segment of maxSegments) assert.ok(Buffer.byteLength(segment) <= PORTABLE_PATH_SEGMENT_BYTES);
});

test("settings and story named settings occupy disjoint physical namespaces", () => {
  const settings = userMutationLedgerSegments("settings", MUTATION);
  const story = userMutationLedgerSegments("story:settings", MUTATION);
  assert.deepEqual(settings.slice(0, 2), ["settings", "user"]);
  assert.deepEqual(story.slice(0, 1), ["stories"]);
  assert.notDeepEqual(settings, story);
  assert.equal(parseMutationLedgerSegments(settings, "settings").aggregateKey, "settings");
  assert.equal(parseMutationLedgerSegments(story, "story:settings").aggregateKey, "story:settings");
});

test("internal Fm1 keys map without a colon and round-trip only as settings", () => {
  const segments = formatMigrationLedgerSegments(FM1);
  assert.deepEqual(segments, ["settings", "internal", `fm1-${"A".repeat(43)}`]);
  assert.ok(segments.every((segment) => !segment.includes(":")));
  assert.deepEqual(parseMutationLedgerSegments(segments, "settings"), {
    kind: "format-migration-v1",
    aggregateKey: "settings",
    key: FM1,
    segments
  });
  assert.throws(() => parseMutationLedgerSegments(segments, "story:settings"));
});

test("path parsing rejects wrong identity, day, shard, token, dot, separators, and colon", () => {
  const story = [...userMutationLedgerSegments("story:story-one", MUTATION)];
  assert.throws(() => parseMutationLedgerSegments(story, "story:other-story"));
  for (const [index, replacement] of [[1, `h1-${"0".repeat(64)}`], [3, "20260102"], [4, "00"]] as const) {
    const copy = [...story];
    copy[index] = replacement;
    assert.throws(() => parseMutationLedgerSegments(copy, "story:story-one"));
  }
  for (const bad of [".", "..", "a/b", "a\\b", "a:b"]) {
    const copy = [...story];
    copy[1] = bad;
    assert.throws(() => parseMutationLedgerSegments(copy, "story:story-one"));
  }
});

test("mutation identity is never inferred by scanning or reversing a story token", () => {
  const segments = userMutationLedgerSegments("story:story-one", MUTATION);
  assert.throws(() => parseMutationLedgerSegments(segments, "story:other-story"));
  assert.throws(() => parseMutationLedgerSegments(segments, "settings"));
  assert.ok(Object.isFrozen(segments));
});

test("malformed path lengths reject before allocating or visiting caller segments", () => {
  const huge = new Proxy(new Array(1_000_000), {
    get(target, property, receiver) {
      if (property === "map") throw new Error("path parser visited malformed segments");
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () => parseMutationLedgerSegments(huge, "settings"),
    MutationLedgerFormatError
  );
});

test("path parsing rejects sparse legal-length segment arrays", () => {
  const cases = [
    { segments: [...userMutationLedgerSegments("settings", MUTATION)], aggregateKey: "settings", holes: [2, 3] },
    {
      segments: [...userMutationLedgerSegments("story:story-one", MUTATION)],
      aggregateKey: "story:story-one",
      holes: [3, 4]
    },
    { segments: [...formatMigrationLedgerSegments(FM1)], aggregateKey: "settings", holes: [2] }
  ] as const;
  for (const { segments, aggregateKey, holes } of cases) {
    for (const index of holes) {
      const sparse: unknown[] = [...segments];
      delete sparse[index];
      assert.throws(
        () => parseMutationLedgerSegments(sparse, aggregateKey),
        MutationLedgerFormatError
      );
    }
  }
});
