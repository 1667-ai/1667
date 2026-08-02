import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFixedContextFits,
  GenerationAdmissionRegistry,
  MAX_GENERATION_MODEL_ATTRIBUTIONS
} from "../server/generation-admission.js";
import { ServiceError } from "../server/errors.js";
import { parseWorkerMutation } from "../server/worker-mutations.js";
import type { GenerationSettings, StoryFact } from "../shared/types.js";

test("generation admission rejects one in-flight story/gen tuple without invoking it", async () => {
  const registry = new GenerationAdmissionRegistry();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = registry.run("story-a", "generation-a", async () => {
    await gate;
    return "first";
  });
  let duplicateInvoked = false;

  await assert.rejects(
    registry.run("story-a", "generation-a", () => {
      duplicateInvoked = true;
      return "duplicate";
    }),
    (error) => error instanceof ServiceError
      && error.status === 409
      && error.code === "resource_busy"
  );
  assert.equal(duplicateInvoked, false);

  release();
  assert.equal(await first, "first");
  assert.equal(
    await registry.run("story-a", "generation-a", () => "retry"),
    "retry"
  );
});

test("generation admission scopes equal IDs by story and releases failures", async () => {
  const registry = new GenerationAdmissionRegistry();
  const marker = new Error("provider failed");
  await assert.rejects(
    registry.run("story-a", "shared", async () => { throw marker; }),
    marker
  );

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = registry.run("story-a", "shared", async () => {
    await gate;
    return "a";
  });
  assert.equal(await registry.run("story-b", "shared", () => "b"), "b");
  assert.equal(await registry.run("story-a", "different", () => "different"), "different");
  release();
  assert.equal(await first, "a");
});

test("generation model attribution is story-scoped, globally bounded, and clearable", () => {
  const registry = new GenerationAdmissionRegistry();
  registry.rememberModel("story-a", "shared", "model-a");
  registry.rememberModel("story-b", "shared", "model-b");
  for (let index = 0; index < MAX_GENERATION_MODEL_ATTRIBUTIONS - 2; index += 1) {
    registry.rememberModel(`story-${index}`, `generation-${index}`, `model-${index}`);
  }

  assert.equal(registry.modelFor("story-a", "shared"), "model-a");
  assert.equal(registry.modelFor("story-b", "shared"), "model-b");
  registry.rememberModel("overflow", "new", "new-model");
  assert.equal(registry.modelFor("story-a", "shared"), undefined);
  assert.equal(registry.modelFor("story-b", "shared"), "model-b");
  assert.equal(registry.modelFor("overflow", "new"), "new-model");

  registry.clear();
  assert.equal(registry.modelFor("story-b", "shared"), undefined);
  assert.equal(registry.modelFor("overflow", "new"), undefined);
});

test("worker continuation targets cannot shadow the authoritative generation envelope", () => {
  const envelope = {
    storyId: "story-a",
    instruction: "Continue.",
    genId: "authoritative",
    target: { parentId: null }
  };
  assert.deepEqual(parseWorkerMutation("continueStory", envelope), envelope);
  for (const shadow of [
    { genId: "shadow" },
    { instruction: "Shadowed instruction." },
    { unknown: true }
  ]) {
    assert.throws(
      () => parseWorkerMutation("continueStory", {
        ...envelope,
        target: { parentId: null, ...shadow }
      }),
      /target\..* is not supported/
    );
  }
});

test("fixed-context admission checks a note-only prompt and names its owner", () => {
  const settings = smallWindowSettings();
  assert.throws(
    () => assertFixedContextFits(settings, [], "x".repeat(100), []),
    (error) => error instanceof ServiceError
      && error.status === 400
      && error.message.includes("Author's Note")
  );
  assert.doesNotThrow(() => assertFixedContextFits(settings, [], null, []));
});

test("fixed-context admission still throws when the only Fact left is exempt from shedding", () => {
  const settings = smallWindowSettings();
  // "always" at the default "normal" priority is never dropped, so a single
  // oversized one leaves nothing droppable and the request still fails.
  const facts = [fact({ id: "exempt", text: "x".repeat(100) })];
  assert.throws(
    () => assertFixedContextFits(settings, facts, null, []),
    (error) => error instanceof ServiceError
      && error.status === 400
      && error.message.includes("story facts")
      && error.message.includes("every droppable fact")
  );
});

test("fixed-context admission sheds a droppable Fact before throwing", () => {
  // A window generous enough for one small Fact's wrapper text, but not for a
  // second, much larger one riding along with it.
  const settings: GenerationSettings = { ...smallWindowSettings(), contextWindow: 1_000 };
  const exempt = fact({ id: "exempt", text: "k", activation: "always" });
  const shed = fact({ id: "shed-me", text: "x".repeat(10_000), activation: "keyed", keys: ["x"] });
  const admission = assertFixedContextFits(settings, [exempt, shed], null, []);
  assert.deepEqual(admission.dropped, [{ factId: "shed-me", reason: "priority" }]);
  assert.deepEqual(admission.facts.map((candidate) => candidate.id), ["exempt"]);
  assert.equal(admission.factsMessage?.includes("x".repeat(10_000)), false);
});

test("fixed-context admission returns the candidates unchanged once everything fits", () => {
  const settings: GenerationSettings = { ...smallWindowSettings(), contextWindow: 1_000 };
  const facts = [fact({ id: "one", text: "A short fact." })];
  const admission = assertFixedContextFits(settings, facts, null, []);
  assert.deepEqual(admission.dropped, []);
  assert.deepEqual(admission.facts, facts);
});

test("fixed-context admission sheds down to what actually fits instead of throwing having dropped nothing", () => {
  // Review finding B, reproduced with the reviewer's own numbers: the old
  // selector measured a Fact's raw text against room sized for the whole
  // rendered Facts block (id-json line, delimiters, text-utf16-length line,
  // and the block preamble), so it could conclude nothing needed to go even
  // though the real formatFactsMessage output did not fit. That produced a
  // throw claiming every droppable Fact was already gone when none had been.
  const settings: GenerationSettings = { ...smallWindowSettings(), contextWindow: 331 };
  const facts = ["a", "b", "c"].map((id) => fact({
    id, text: "x".repeat(400), activation: "keyed", keys: ["x"]
  }));
  const admission = assertFixedContextFits(settings, facts, null, []);
  // Exactly one Fact fits once the real per-Fact wrapper cost is counted;
  // the old code kept all three and then threw.
  assert.equal(admission.facts.length, 1);
  assert.equal(admission.dropped.length, 2);
  assert.equal(admission.dropped.every((drop) => drop.reason === "priority"), true);
});

test("fixed-context admission never blames a Fact's own cap on a different estimator than the cap was set against", () => {
  // Review finding C: the selector's own-cap gate used to take whichever
  // per-Fact cost model the caller passed for sizing space against the
  // window — admission passed a conservative estimator that doubles
  // non-ASCII text, so it could score a CJK Fact over its own cap even
  // though the plain ~4-chars-per-token estimate every other surface uses
  // for budgetTokens (the rail, the meter, the docs) scores it well under.
  // A tight window here forces admission to actually shed something; the
  // fix is that whatever it sheds, a Fact under its real cap is never the
  // one blamed with reason "fact-budget".
  const settings: GenerationSettings = { ...smallWindowSettings(), contextWindow: 60 };
  const cjk = fact({
    id: "cjk", text: "玲".repeat(100), activation: "keyed", keys: ["x"], budgetTokens: 50
  });
  // ceil(100 / 4) = 25 <= 50 under the canonical estimator — well under cap.
  const admission = assertFixedContextFits(settings, [cjk], null, []);
  assert.equal(
    admission.dropped.some((drop) => drop.factId === "cjk" && drop.reason === "fact-budget"),
    false
  );
});

function fact(overrides: Partial<StoryFact> & Pick<StoryFact, "id" | "text">): StoryFact {
  return {
    tag: null,
    activation: "always",
    keys: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function smallWindowSettings(): GenerationSettings {
  return {
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 1,
    systemPrompt: "",
    contextWindow: 32
  };
}
