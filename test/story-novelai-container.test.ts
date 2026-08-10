import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ServiceError } from "../server/errors.js";
import { partsFromNovelAiScenario } from "../server/import-scenario.js";
import { StoryService } from "../server/story-service.js";
import { MAX_AUTHORS_NOTE_CHARS } from "../shared/authors-note.js";
import { fidelityReport } from "../shared/fidelity.js";
import { MAX_FACTS, MAX_FACT_TEXT_CHARS } from "../shared/types.js";
import {
  novelAiLorebook,
  novelAiScenario,
  novelAiStoryContainer
} from "./novelai-container-fixture.js";

test("A long Memory is cut on a paragraph boundary and reported", async (t) => {
  const service = await temporaryService(t);
  // Sized off MAX_FACT_TEXT_CHARS rather than a fresh literal, so this stays
  // correct if the cap moves again: firstParagraph alone sits past the cap's
  // floor (half the cap), and firstParagraph + secondParagraph together pass
  // the cap, so the cut must land on the paragraph break and drop the second
  // paragraph whole.
  const firstParagraph = "m".repeat(Math.floor(MAX_FACT_TEXT_CHARS * 0.75));
  const secondParagraph = "n".repeat(Math.floor(MAX_FACT_TEXT_CHARS * 0.5));
  const result = await service.importNovelAIWithReport(novelAiStoryContainer({
    context: { memory: `${firstParagraph}\n\n${secondParagraph}` }
  }));

  assert.equal(result.payload.facts[0]?.text, firstParagraph);
  assert.ok(result.payload.facts[0]!.text.length <= MAX_FACT_TEXT_CHARS);
  assert.match(
    fidelityReport(result.fidelity),
    new RegExp(`memory truncated to ${MAX_FACT_TEXT_CHARS.toLocaleString()} characters`, "u")
  );
});

test("A long Author's Note is cut to 4,000 Unicode scalars and reported", async (t) => {
  const service = await temporaryService(t);
  const result = await service.importNovelAIWithReport(novelAiStoryContainer({
    context: { authorsNote: "😀".repeat(MAX_AUTHORS_NOTE_CHARS + 1) }
  }));

  assert.equal(result.payload.authorsNote, "😀".repeat(MAX_AUTHORS_NOTE_CHARS));
  assert.match(
    fidelityReport(result.fidelity),
    /author's note truncated to 4,000 characters/u
  );
});

test("Memory takes the first Fact slot before 130 Lorebook Entries", async (t) => {
  const service = await temporaryService(t);
  const result = await service.importNovelAIWithReport(novelAiStoryContainer({
    context: { memory: "Persistent memory." },
    lorebook: novelAiLorebook(130)
  }));

  assert.equal(result.payload.facts.length, MAX_FACTS);
  assert.deepEqual(result.payload.facts[0], {
    ...result.payload.facts[0],
    tag: "memory",
    text: "Persistent memory.",
    activation: "always",
    keys: []
  });
  assert.equal(result.payload.facts[1]?.tag, "Lore 1");
  assert.match(fidelityReport(result.fidelity), /3 entries did not fit the 128-fact limit/u);
});

test("A Container without context or a Lorebook imports prose without a Fact report", async (t) => {
  const service = await temporaryService(t);
  const result = await service.importNovelAIWithReport(novelAiStoryContainer({
    prose: ["First prose.", "Second prose."]
  }));

  assert.deepEqual(result.payload.path.map(({ text }) => text), [
    "First prose.",
    "Second prose."
  ]);
  assert.equal(result.payload.facts.length, 0);
  assert.doesNotMatch(fidelityReport(result.fidelity), /fact/u);
});

test("A scenarioVersion 2 Scenario is refused by field name", () => {
  assert.throws(
    () => partsFromNovelAiScenario(novelAiScenario({ version: 2 })),
    (error: unknown) => error instanceof ServiceError
      && error.status === 400
      && error.message.includes("scenarioVersion")
  );
});

async function temporaryService(t: test.TestContext): Promise<StoryService> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-container-import-"));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  return service;
}

test("A Container whose embedded Lorebook has an unknown version still imports its prose", async (t) => {
  const service = await temporaryService(t);
  // #231 imported the prose of every Container. A Lorebook version this build
  // cannot read must not take that away.
  const result = await service.importNovelAIWithReport(novelAiStoryContainer({
    prose: ["The keeper trimmed the wick."],
    lorebook: { lorebookVersion: 5, entries: [{ text: "unreadable", enabled: true }] }
  }));

  assert.equal(result.payload.path.length, 1);
  assert.equal(result.payload.facts.length, 0);
  assert.match(fidelityReport(result.fidelity), /lorebook version 5 not read/u);
});

test("Memory that carried carriage returns says its line endings changed", async (t) => {
  const service = await temporaryService(t);
  const result = await service.importNovelAIWithReport(novelAiStoryContainer({
    context: { memory: "a memory\r\nwith carriage returns" }
  }));

  assert.equal(result.payload.facts[0]?.text, "a memory\nwith carriage returns");
  assert.match(fidelityReport(result.fidelity), /memory changed to line feeds/u);
});
