import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { selectFactsWithinBudget } from "../shared/fact-budget.js";
import { effectiveFactAtPath, firstFactText, type EffectiveStoryFact } from "../shared/fact-state.js";
import { StoryService } from "../server/story-service.js";
import type { StoryPayload } from "../shared/types.js";

test("fact order, priority, and budget round-trip through create, patch, reorder, and reload", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-order-priority-budget-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();

  const created = await service.createStory("Fact order");
  await service.createFact(created.id, { text: "First fact." });
  await service.createFact(created.id, { text: "Second fact.", priority: "high", budgetTokens: 500 });
  const third = await service.createFact(created.id, { text: "Third fact." });
  assert.deepEqual(third.facts.map((fact) => firstFactText(fact)), ["First fact.", "Second fact.", "Third fact."]);
  // Default priority never appears on the wire; an explicit non-default one does.
  assert.equal("priority" in third.facts[0]!, false);
  assert.equal(third.facts[1]!.priority, "high");
  assert.equal(third.facts[1]!.budgetTokens, 500);
  const [firstId, secondId, thirdId] = third.facts.map((fact) => fact.id) as [string, string, string];

  // Reorder: move the third Fact to the front.
  const reordered = await service.reorderFact(created.id, thirdId, { toIndex: 0 });
  assert.deepEqual(reordered.facts.map((fact) => fact.id), [thirdId, firstId, secondId]);

  // Patch priority to "low" and back to "normal"; the default omits the field.
  const lowered = await service.patchFact(created.id, firstId, { priority: "low" });
  assert.equal(lowered.facts.find((fact) => fact.id === firstId)!.priority, "low");
  const normalized = await service.patchFact(created.id, firstId, { priority: "normal" });
  assert.equal("priority" in normalized.facts.find((fact) => fact.id === firstId)!, false);

  // Patch budgetTokens on, then clear it with null.
  const budgeted = await service.patchFact(created.id, thirdId, { budgetTokens: 1_200 });
  assert.equal(budgeted.facts.find((fact) => fact.id === thirdId)!.budgetTokens, 1_200);
  const cleared = await service.patchFact(created.id, thirdId, { budgetTokens: null });
  assert.equal("budgetTokens" in cleared.facts.find((fact) => fact.id === thirdId)!, false);

  await service.dispose();

  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const reloaded = await service.loadStory(created.id);
    assert.deepEqual(reloaded.facts.map((fact) => fact.id), [thirdId, firstId, secondId]);
    assert.equal("priority" in reloaded.facts.find((fact) => fact.id === firstId)!, false);
    assert.equal(reloaded.facts.find((fact) => fact.id === secondId)!.priority, "high");
    assert.equal(reloaded.facts.find((fact) => fact.id === secondId)!.budgetTokens, 500);
    assert.equal("budgetTokens" in reloaded.facts.find((fact) => fact.id === thirdId)!, false);
  } finally {
    await service.dispose();
  }
});

test("reorderFact clamps an out-of-range index and rejects an unknown Fact", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-reorder-bounds-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const created = await service.createStory("Fact reorder bounds");
    const first = await service.createFact(created.id, { text: "One" });
    const second = await service.createFact(created.id, { text: "Two" });
    const firstId = first.facts[0]!.id;
    const secondId = second.facts[1]!.id;

    const clamped = await service.reorderFact(created.id, firstId, { toIndex: 999 });
    assert.deepEqual(clamped.facts.map((fact) => fact.id), [secondId, firstId]);

    await assert.rejects(
      service.reorderFact(created.id, "unknown-fact", { toIndex: 0 }),
      /Fact not found/
    );
  } finally {
    await service.dispose();
  }
});

test("setFactsBudget round-trips and, once set, sheds the story's low-priority Facts", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-facts-budget-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();

  const created = await service.createStory("Facts budget");
  await service.createFact(created.id, { text: "A short, important fact." });
  const withLow = await service.createFact(created.id, {
    text: "A much longer fact that only matters when the window has room to spare for it.",
    priority: "low"
  });
  const [keptId, shedId] = withLow.facts.map((fact) => fact.id) as [string, string];
  const withLowEffective = effectiveFacts(withLow);

  // No budget yet: both Facts stand, regardless of priority.
  const unbudgeted = selectFactsWithinBudget(withLowEffective, null);
  assert.deepEqual(unbudgeted.kept.map((fact) => fact.id), [keptId, shedId]);

  // Setting the budget is rejected outside its bounds...
  await assert.rejects(service.setFactsBudget(created.id, 0), /factsBudgetTokens/);

  // ...and takes effect once valid: tight enough to force the low-priority
  // Fact out but not the other one.
  const budget = Math.ceil(withLowEffective[0]!.text.length / 4) + 1;
  const budgeted = await service.setFactsBudget(created.id, budget);
  assert.equal(budgeted.factsBudgetTokens, budget);

  const selection = selectFactsWithinBudget(effectiveFacts(budgeted), budgeted.factsBudgetTokens ?? null, {
    spaceDropReason: "total-budget"
  });
  assert.deepEqual(selection.kept.map((fact) => fact.id), [keptId]);
  assert.deepEqual(selection.dropped, [{ factId: shedId, reason: "total-budget" }]);

  // Clearing with null removes the field rather than leaving it at zero.
  const cleared = await service.setFactsBudget(created.id, null);
  assert.equal("factsBudgetTokens" in cleared, false);

  await service.dispose();
  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const reloaded = await service.loadStory(created.id);
    assert.equal(reloaded.factsBudgetTokens, undefined);
  } finally {
    await service.dispose();
  }
});

function effectiveFacts(payload: Pick<StoryPayload, "facts" | "path">): EffectiveStoryFact[] {
  return payload.facts.flatMap((fact) => {
    const effective = effectiveFactAtPath(fact, payload.path);
    return effective === null ? [] : [effective];
  });
}

test("fact mutation rejects an out-of-range priority and budget", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-priority-budget-validation-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Fact priority validation");
    await assert.rejects(
      service.createFact(story.id, { text: "Invalid", priority: "urgent" as never }),
      /priority/i
    );
    await assert.rejects(
      service.createFact(story.id, { text: "Invalid", budgetTokens: 0 }),
      /budgetTokens/
    );
    assert.equal((await service.loadStory(story.id)).facts.length, 0);
  } finally {
    await service.dispose();
  }
});
