import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryService } from "../server/story-service.js";
import { MAX_FACT_TEXT_CHARS } from "../shared/types.js";

// Fact text is content-addressed (scripts/story-schema-definition.ts
// `StoredFactV5` carries only `revisionId`, not the text itself), so raising
// MAX_FACT_TEXT_CHARS changes no on-disk schema. This is the test that proves
// that in practice: a Fact at the new ceiling actually survives a real
// create -> dispose -> reload cycle through the production storage path,
// rather than only passing the admission check that lets it in.
test("a Fact at the new character ceiling round-trips through create, save, and reload intact", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-text-limit-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();

  const story = await service.createStory("Near the ceiling");
  // Multi-byte and astral content on top of plain ASCII, so the round trip
  // also proves the content-addressed store keeps the text exactly — no
  // re-encoding drift at this size. "\n\n" and "!" cost 3 scalars, so the
  // banner repeat count is derived rather than picked to land exactly on
  // the ceiling regardless of where it sits.
  const astralCount = 1_000;
  const bannerCount = MAX_FACT_TEXT_CHARS - astralCount - 3;
  const nearLimitText = `${"銀".repeat(bannerCount)}\n\n${"𐐀".repeat(astralCount)}!`;
  assert.equal([...nearLimitText].length, MAX_FACT_TEXT_CHARS, "fixture must sit exactly at the ceiling");

  const created = await service.createFact(story.id, { text: nearLimitText, tag: "ceiling" });
  const factId = created.facts[0]!.id;
  assert.equal(created.facts[0]!.text, nearLimitText);

  await service.dispose();
  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const reloaded = await service.loadStory(story.id);
    const fact = reloaded.facts.find(({ id }) => id === factId);
    assert.equal(fact?.text, nearLimitText);
    assert.equal(fact?.text.length, nearLimitText.length);
  } finally {
    await service.dispose();
  }
});

test("one Unicode scalar over the ceiling is still refused", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-text-limit-over-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Over the ceiling");
    await assert.rejects(
      service.createFact(story.id, { text: "x".repeat(MAX_FACT_TEXT_CHARS + 1) }),
      new RegExp(`${MAX_FACT_TEXT_CHARS}-character limit`)
    );
    assert.equal((await service.loadStory(story.id)).facts.length, 0);
  } finally {
    await service.dispose();
  }
});
