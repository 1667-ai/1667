import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mapWithConcurrency } from "../server/concurrency.js";
import { ServiceError } from "../server/errors.js";
import { STORY_SCHEMA_VERSION, type StoryManifestV5 } from "../server/story-format.js";
import {
  STORY_CREATE_RESIDUE_PREFIX,
  STORY_REAP_RESIDUE_PREFIX
} from "../server/story-residue.js";
import { buildStorySummary } from "../server/story-summary.js";
import {
  MAX_STORY_INSTRUCTION_CHARS,
  MAX_STORY_MANIFEST_BYTES
} from "../server/story-v5-strict.js";
import { formatV6, parseStoryManifestBytes } from "../server/story-v6-codec.js";
import type { DeletedStoryManifestV6, LiveStoryManifestV6 } from "../server/story-v6-types.js";
import { StoryStore } from "../server/stories.js";
import {
  assertWithinBudget,
  budgetTimeout,
  cpuBudget,
  startTiming
} from "./performance-budget.js";

const NOW = "2026-01-01T00:00:00.000Z";
const HASH = "a".repeat(64);
const MIB = 1024 * 1024;
// Parsing is pure computation.
const V5_PARSE_BUDGET = cpuBudget(1_500);
const V6_PARSE_BUDGET = cpuBudget(4_000);
// Listing the catalog reads directories, but the reads run together while each
// manifest is parsed, so computation rather than waiting decides the time. The
// listing reports more CPU time than wall-clock time: 1,436ms of CPU against
// 854ms of wall-clock on an idle arm64 baseline.
//
// A wall-clock budget therefore measures the scheduler. Beside 16 busy
// processes the wall-clock time went up 2.9 times and the CPU time 1.4 times,
// and a full-concurrency suite run reached 21,590ms, which failed the earlier
// 5,000ms wall-clock budget while the product did the same work.
//
// The limit comes from measurement. The worst CPU time beside 16 busy processes
// was 2,048ms, and this limit keeps about three times that.
//
// CPU time cannot see a listing that blocks instead of works. The test timeout
// below is the backstop for that.
const CATALOG_BUDGET = cpuBudget(6_000);
const CATALOG_ENTRY_COUNT = 4_096;
const FIXTURE_IO_CONCURRENCY = 64;

test("story wire performance", {
  concurrency: 1,
  timeout: budgetTimeout([V5_PARSE_BUDGET, V6_PARSE_BUDGET, CATALOG_BUDGET], 60_000)
}, async (t) => {
  await t.test("near-limit strict V5 and canonical V6 parsing stay in budget", (context) => {
    const content = largeManifest();
    const v5Bytes = Buffer.from(JSON.stringify(content), "utf8");
    const v6Bytes = Buffer.from(formatV6(liveV6(content)), "utf8");
    assert.ok(v5Bytes.byteLength >= 12 * MIB, `V5 fixture is only ${formatMib(v5Bytes.byteLength)}`);
    assert.ok(v6Bytes.byteLength >= 12 * MIB, `V6 fixture is only ${formatMib(v6Bytes.byteLength)}`);
    assert.ok(v6Bytes.byteLength < MAX_STORY_MANIFEST_BYTES);

    const readV5 = startTiming();
    const parsedV5 = parseStoryManifestBytes(v5Bytes, content.id);
    const v5Timing = readV5();

    const readV6 = startTiming();
    const parsedV6 = parseStoryManifestBytes(v6Bytes, content.id);
    const v6Timing = readV6();

    assert.equal(parsedV5.kind, "v5");
    assert.equal(parsedV6.kind, "v6-live");
    assertWithinBudget(
      context,
      `${formatMib(v5Bytes.byteLength)} strict V5 parse`,
      V5_PARSE_BUDGET,
      v5Timing
    );
    assertWithinBudget(
      context,
      `${formatMib(v6Bytes.byteLength)} canonical V6 parse`,
      V6_PARSE_BUDGET,
      v6Timing
    );
  });

  await t.test("a 4096-entry mixed catalog lists without hydrating V6 content", async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "1667-wire-performance-"));
    const store = new StoryStore(root);
    await store.init();
    context.after(async () => {
      await store.waitForMaintenance();
      await rm(root, { recursive: true, force: true });
    });

    const entries = catalogEntries();
    assert.equal(entries.length, CATALOG_ENTRY_COUNT);
    await mapWithConcurrency(entries, FIXTURE_IO_CONCURRENCY, async (entry) => {
      const directory = path.join(root, entry.name);
      await mkdir(directory);
      if (entry.manifest !== null) await writeFile(path.join(directory, "manifest.json"), entry.manifest);
    });

    const read = startTiming();
    const summaries = await store.list();
    const timing = read();

    const v5Count = summaries.filter(({ id }) => id.startsWith("v5-")).length;
    const v6Count = summaries.filter(({ id }) => id.startsWith("v6-")).length;
    assert.equal(v5Count, 1_024);
    assert.equal(v6Count, 1_024);
    assert.equal(summaries.length, 2_048);
    assertWithinBudget(
      context,
      `${CATALOG_ENTRY_COUNT.toLocaleString()} mixed entries — `
      + `${summaries.length.toLocaleString()} live summaries`,
      CATALOG_BUDGET,
      timing
    );

    await assert.rejects(
      () => store.loadForMutation("v6-0000"),
      (error: unknown) => error instanceof ServiceError && error.code === "story_manifest_requires_successor"
    );
  });
});

interface CatalogEntry {
  name: string;
  manifest: string | null;
}

function catalogEntries(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (let index = 0; index < 1_024; index += 1) {
    const suffix = index.toString().padStart(4, "0");
    const v5Id = `v5-${suffix}`;
    entries.push({ name: v5Id, manifest: JSON.stringify(smallManifest(v5Id)) });

    const v6Id = `v6-${suffix}`;
    entries.push({ name: v6Id, manifest: formatV6(liveV6(smallManifest(v6Id))) });

    const deletedId = `deleted-${suffix}`;
    entries.push({ name: deletedId, manifest: formatV6(deletedV6(deletedId)) });

    const residueId = `residue-${suffix}`;
    entries.push({
      name: `${index % 2 === 0 ? STORY_CREATE_RESIDUE_PREFIX : STORY_REAP_RESIDUE_PREFIX}${residueId}`,
      manifest: null
    });
  }
  return entries;
}

function largeManifest(): StoryManifestV5 {
  const instruction = "x".repeat(MAX_STORY_INSTRUCTION_CHARS - 128);
  return manifest("large-story", Array.from({ length: 12 }, (_, index) => ({
    id: `part-${index}`,
    parentId: index === 0 ? null : `part-${index - 1}`,
    instruction,
    model: "performance",
    createdAt: NOW,
    revisionId: HASH,
    activeChildId: index === 11 ? null : `part-${index + 1}`
  })));
}

function smallManifest(id: string): StoryManifestV5 {
  return manifest(id, [{
    id: `${id}-root`,
    parentId: null,
    instruction: "Continue",
    model: "performance",
    createdAt: NOW,
    revisionId: HASH,
    activeChildId: null
  }]);
}

function manifest(id: string, nodes: StoryManifestV5["nodes"]): StoryManifestV5 {
  return {
    format: "1667-story",
    schemaVersion: STORY_SCHEMA_VERSION,
    id,
    title: id,
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: nodes.length,
    nodes,
    facts: [],
    activeRootId: nodes[0]?.id ?? null,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
}

function liveV6(content: StoryManifestV5): LiveStoryManifestV6 {
  const summary = buildStorySummary(content);
  return {
    format: "1667-story",
    schemaVersion: 6,
    kind: "live",
    id: content.id,
    revision: "00000000000000000001",
    previousManifestHash: null,
    content,
    summary: {
      ...summary,
      words: uint64(summary.words),
      lineCount: uint64(summary.lineCount)
    },
    unresolvedProvider: null,
    lastTransaction: null
  };
}

function deletedV6(id: string): DeletedStoryManifestV6 {
  return {
    format: "1667-story",
    schemaVersion: 6,
    kind: "deleted",
    id,
    revision: "00000000000000000002",
    previousManifestHash: HASH,
    deletedAt: NOW,
    unresolvedProvider: null,
    lastTransaction: {
      receiptKind: "user",
      mutationId: "m1.1767225600000.0123456789abcdef0123456789abcdef",
      phase: "prepared"
    }
  };
}

function uint64(value: number): string {
  return BigInt(value).toString().padStart(20, "0");
}

function formatMib(bytes: number): string {
  return `${(bytes / MIB).toFixed(2)}MiB`;
}
