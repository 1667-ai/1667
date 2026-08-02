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
