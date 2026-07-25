import assert from "node:assert/strict";
import test from "node:test";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { hasCommittedGeneration } from "../server/story-nodes.js";
import type { Story, StoryNode } from "../shared/types.js";

const NODE_COUNT = 20_000;
const LOOKUP_ROUNDS = 500;
const REGISTRY_ROUNDS = 25_000;
const CPU_BUDGET_MS = 8_000;

test("generation lookup and admission churn stay comfortably bounded", { timeout: 30_000 }, async (t) => {
  const story = largeStory();
  const registry = new GenerationAdmissionRegistry();
  assert.equal(hasCommittedGeneration(story, "committed-at-the-end"), true);

  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  let lookups = 0;
  for (let round = 0; round < LOOKUP_ROUNDS; round += 1) {
    lookups += Number(hasCommittedGeneration(story, "committed-at-the-end"));
    lookups += Number(hasCommittedGeneration(story, "not-committed"));
  }
  let churn = 0;
  for (let round = 0; round < REGISTRY_ROUNDS; round += 1) {
    churn += await registry.run(
      `story-${round % 32}`,
      `generation-${round % 64}`,
      () => 1
    );
  }
  const usage = process.cpuUsage(cpuStart);
  const cpuMs = (usage.user + usage.system) / 1_000;
  const wallMs = performance.now() - wallStart;

  assert.equal(lookups, LOOKUP_ROUNDS);
  assert.equal(churn, REGISTRY_ROUNDS);
  assert.ok(
    cpuMs < CPU_BUDGET_MS,
    `generation admission benchmark used ${cpuMs.toFixed(1)}ms CPU; budget is ${CPU_BUDGET_MS}ms`
  );
  t.diagnostic(
    `${(NODE_COUNT * LOOKUP_ROUNDS * 2).toLocaleString()} node checks + `
    + `${REGISTRY_ROUNDS.toLocaleString()} registry cycles: `
    + `${cpuMs.toFixed(1)}ms CPU, ${wallMs.toFixed(1)}ms wall`
  );
});

function largeStory(): Story {
  const nodes: StoryNode[] = Array.from({ length: NODE_COUNT }, (_, index) => ({
    id: `node-${index}`,
    parentId: null,
    activeChildId: null,
    instruction: "",
    text: "Fixture.",
    model: "benchmark",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(index === NODE_COUNT - 1 ? { genId: "committed-at-the-end" } : {})
  }));
  return {
    id: "generation-admission-benchmark",
    title: "Benchmark",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes,
    activeRootId: null,
    bookmarks: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}
