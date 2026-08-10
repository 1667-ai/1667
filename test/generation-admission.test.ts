import assert from "node:assert/strict";
import test from "node:test";
import {
  admitFactsIntoPrompt,
  assertFixedContextFits,
  GenerationAdmissionRegistry,
  MAX_GENERATION_MODEL_ATTRIBUTIONS
} from "../server/generation-admission.js";
import { ServiceError } from "../server/errors.js";
import { parseWorkerMutation } from "../server/worker-mutations.js";
import { continuationPlan } from "../shared/continuation-plan.js";
import type { GenerationSettings, StoryFact, StoryNode } from "../shared/types.js";

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

test("fixed-context admission names the priority-marking remedy when nothing was droppable at all", () => {
  // Review finding E: a default "always"/"normal" Fact is never droppable, so
  // a story of default Facts has zero droppable Facts and the shed loop never
  // runs. The old message claimed shedding was exhausted ("even after
  // dropping every droppable fact") when nothing had ever been dropped — this
  // is the common case that message got wrong, not an edge case.
  const settings = smallWindowSettings();
  const facts = [fact({ id: "exempt", text: "x".repeat(100) })];
  assert.throws(
    () => assertFixedContextFits(settings, facts, null, []),
    (error) => error instanceof ServiceError
      && error.status === 400
      && error.message.includes("story facts")
      && error.message.includes("none of them can be dropped")
      && error.message.includes("low")
      && !error.message.includes("every droppable fact")
  );
});

test("fixed-context admission keeps the shed-exhausted wording when something actually was droppable", () => {
  // The companion case to the one above: at least one Fact was droppable, it
  // was shed, and the request still does not fit. That is a different writer
  // situation from "nothing was eligible" and keeps the original wording.
  const settings = smallWindowSettings();
  const facts = [
    fact({ id: "exempt", text: "x".repeat(100) }),
    fact({ id: "shed-me", text: "y".repeat(100), activation: "keyed", keys: ["y"] })
  ];
  assert.throws(
    () => assertFixedContextFits(settings, facts, null, []),
    (error) => error instanceof ServiceError
      && error.status === 400
      && error.message.includes("story facts")
      && error.message.includes("every droppable fact")
      && !error.message.includes("none of them can be dropped")
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

test("fixed-context admission finds the exact shed count across many sheddable Facts", () => {
  // Review finding K: the shed loop now binary-searches the smallest shed
  // count instead of trying one Fact at a time, so this exercises several
  // probes (16 equal-cost Facts needs about 4). Each kept-count's real,
  // rendered cost was measured directly (not estimated) to pick a window
  // that admits exactly 6 of 16 — tight enough that 7 does not fit.
  const settings: GenerationSettings = { ...smallWindowSettings(), contextWindow: 900 };
  const facts = Array.from({ length: 16 }, (_, index) => fact({
    id: `f${index}`, text: "x".repeat(400), activation: "keyed", keys: ["x"]
  }));
  const admission = assertFixedContextFits(settings, facts, null, []);
  // Later emit position sheds first (shared/fact-budget.ts's tiebreak), so
  // the survivors are the earliest Facts in emit order, not an arbitrary six.
  assert.deepEqual(admission.facts.map((candidate) => candidate.id),
    ["f0", "f1", "f2", "f3", "f4", "f5"]);
  assert.equal(admission.dropped.length, 10);
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

test("Facts shedding and a deep Author's Note compose: shedding a Fact neither moves nor double-counts the note", () => {
  // #278/#283 moved the Author's Note to a configurable depth among the story
  // parts; #281 rewrote admission to shed Facts one at a time and rebuild the
  // real prompt. This settles the hazard where those two land on the same
  // prompt: a window tight enough to force a shed must still place the note
  // at its requested depth, and must count the note's cost exactly once.
  const settings: GenerationSettings = { ...smallWindowSettings(), contextWindow: 1_000 };
  const exempt = fact({ id: "exempt", text: "k", activation: "always" });
  const shed = fact({ id: "shed-me", text: "x".repeat(10_000), activation: "keyed", keys: ["x"] });
  const authorsNote = "Keep the tone tense.";
  const authorsNotePlacement = { text: authorsNote, depth: 2 };
  const parts = [
    node("p1", "Open.", "The door creaked."),
    node("p2", "Two.", "She stepped inside."),
    node("p3", "Three.", "Something moved upstairs.")
  ];

  const { plan, admission } = admitFactsIntoPrompt(
    settings,
    [exempt, shed],
    authorsNote,
    (factsMessage) => continuationPlan(
      "Write vivid prose.",
      factsMessage,
      authorsNotePlacement,
      parts,
      "Continue.",
      false,
      true,
      "ct-11111111",
      [],
      parts
    )
  );

  // The Fact that overflows the window is shed, exactly as it would be with
  // no note in play.
  assert.deepEqual(admission.dropped, [{ factId: "shed-me", reason: "priority" }]);
  assert.deepEqual(admission.facts.map((candidate) => candidate.id), ["exempt"]);

  // The note still lands two story parts from the end — rebuilding the prompt
  // with fewer Facts does not drift its placement.
  const noteIndex = plan.entries.findIndex((entry) => entry.category === "note");
  assert.notEqual(noteIndex, -1);
  assert.equal((plan.entries[noteIndex] as { partsAfterNote: number }).partsAfterNote, 2);

  // fixedPromptTexts excludes the note by block kind, so admission counts its
  // cost exactly once (via the authorsNote argument), never through otherFixed.
  const noteBlocks = plan.prompt.turns.flatMap((turn) => turn.blocks)
    .flatMap((block) => block.kind === "authors-note" ? [block.text] : []);
  assert.equal(noteBlocks.length, 1);
  assert.equal(noteBlocks[0], authorsNote);
});

function node(id: string, instruction: string, text: string): StoryNode {
  return {
    id,
    parentId: null,
    instruction,
    text,
    model: "test",
    createdAt: "2025-01-01T00:00:00.000Z",
    activeChildId: null
  };
}

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
