/** End-to-end mutation latency harness for 1667. Run: bun bench/mutation.ts
 *  Drives the real client path — createWorkerStoryApi over a freshly seeded
 *  vault — and times the keypress-to-durable-commit round trip that #42
 *  measured by hand: reads as the control group, then switchLine and editNode
 *  as the interactive mutation worst cases. Report-only: the value is a
 *  tracked number for every storage change, not a CI budget. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StoryPayload } from "../../shared/types.js";
import { createWorkerStoryApi } from "../src/worker-api.js";

interface BenchRow {
  label: string;
  p50Ms: number;
  minMs: number;
  maxMs: number;
}

function measuredRow(label: string, samples: readonly number[]): BenchRow {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value: number) => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? 0;
  return {
    label,
    p50Ms: percentile(0.5),
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0
  };
}

async function time(
  label: string,
  run: () => Promise<unknown>,
  iterations = 15
): Promise<BenchRow> {
  await run(); // warm once
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  return measuredRow(label, samples);
}

function lastPathNode(payload: StoryPayload): StoryPayload["path"][number] {
  const node = payload.path.at(-1);
  if (node === undefined) throw new Error("The seeded story has an empty active path");
  return node;
}

/** Two sibling takes of one seam, preferring a pair the seeded tour ships. */
function siblingTakePair(payload: StoryPayload): readonly [string, string] | null {
  const byParent = new Map<string | null, string[]>();
  for (const node of payload.nodes) {
    const group = byParent.get(node.parentId) ?? [];
    group.push(node.id);
    byParent.set(node.parentId, group);
  }
  const onLine = new Set(payload.path.map((node) => node.id));
  let fallback: readonly [string, string] | null = null;
  for (const group of byParent.values()) {
    if (group.length < 2) continue;
    const pair = [group[0]!, group[1]!] as const;
    if (group.some((id) => onLine.has(id))) return pair;
    fallback ??= pair;
  }
  return fallback;
}

const vaultParent = await mkdtemp(path.join(tmpdir(), "1667-mutation-bench-"));
const dataDir = path.join(vaultParent, "vault");
const backend = await createWorkerStoryApi({ dataDir });
const rows: BenchRow[] = [];
try {
  const api = backend.api;
  await backend.recovery;

  rows.push(await time("listStories (read)", () => api.listStories()));

  const stories = await api.listStories();
  const storyId = stories[0]?.id;
  if (storyId === undefined) throw new Error("The fresh vault seeded no stories");
  rows.push(await time("loadStory (read)", () => api.loadStory(storyId)));

  let payload = await api.loadStory(storyId);
  let pair = siblingTakePair(payload);
  if (pair === null) {
    const seam = lastPathNode(payload);
    payload = await api.createNode(storyId, {
      parentId: seam.parentId,
      instruction: "",
      text: "A bench take of the same seam."
    });
    pair = siblingTakePair(payload);
    if (pair === null) throw new Error("Could not build a sibling take pair");
  }
  const [firstTake, secondTake] = pair;
  let nextTake = firstTake;
  rows.push(await time("switchLine (mutation)", async () => {
    await api.switchLine(storyId, nextTake);
    nextTake = nextTake === firstTake ? secondTake : firstTake;
  }));

  payload = await api.loadStory(storyId);
  let editCounter = 0;
  rows.push(await time("editNode (content mutation)", async () => {
    const target = lastPathNode(payload);
    editCounter += 1;
    payload = await api.editNode(storyId, target, {
      text: `${target.text} +${editCounter}`
    });
  }));
} finally {
  await backend.dispose();
  await rm(vaultParent, { recursive: true, force: true });
}

const width = Math.max(...rows.map((row) => row.label.length)) + 2;
for (const row of rows) {
  process.stdout.write(
    `${row.label.padEnd(width)}`
    + ` p50 ${row.p50Ms.toFixed(2).padStart(8)}ms`
    + `  min ${row.minMs.toFixed(2).padStart(8)}ms`
    + `  max ${row.maxMs.toFixed(2).padStart(8)}ms\n`
  );
}
