import assert from "node:assert/strict";
import test from "node:test";
import { autonamePrompt, GeneratedTitleError, normalizeGeneratedTitle } from "../server/autoname.js";
import { fixedPromptTexts, renderPromptPlan } from "../shared/prompt-plan.js";
import type { Story, StoryFact, StoryNode } from "../shared/types.js";

test("autoname: fork prompt names the source and separates inherited prose from its new path", () => {
  const inherited = part("origin-part", "Open in the old lighthouse.", "The old beam crossed the winter sea.");
  const branchOnly = part("branch-part", "The keeper follows the false light.", "At dawn, a second sun waited below the cliffs.");
  const story = fixture([inherited, branchOnly], {
    title: "The Winter Beam (branch)",
    origin: {
      storyId: "source-story",
      storyTitle: "The Winter Beam",
      partId: inherited.id,
      offset: null,
      createdAt: "2025-01-01T00:00:00.000Z"
    }
  });

  const messages = renderPromptPlan(autonamePrompt(story, "Write maritime folk horror.").prompt);
  assert.match(messages[2]!.content, /fork of the different story titled "The Winter Beam"/);
  assert.match(messages[2]!.content, /<inherited-from-source>[\s\S]*The old beam/);
  assert.match(messages[2]!.content, /<written-on-this-branch>[\s\S]*second sun/);
  assert.match(messages[2]!.content, /must not copy it/);
});

test("autoname: a fresh fork with no new prose is identified explicitly", () => {
  const inherited = part("origin-part", "Open at the crossroads.", "Three roads vanished into rain.");
  const story = fixture([inherited], {
    origin: {
      storyId: "source-story",
      storyTitle: "All Roads in Rain",
      partId: inherited.id,
      offset: 24,
      createdAt: "2025-01-01T00:00:00.000Z"
    }
  });

  const prompt = renderPromptPlan(autonamePrompt(story, "").prompt)[1]!.content;
  assert.match(prompt, /No branch-only continuation has been written yet/);
  assert.match(prompt, /character 24/);
});

test("autoname: canonical facts message includes the flat text", () => {
  const opening = part("opening", "Begin.", "Aya entered the gate.");
  const ending = part("ending", "Continue.", "The trial ended at dawn.");
  const story = fixture([opening, ending], {
    facts: [fact("hero", "Level: 5")]
  });
  const prompt = autonamePrompt(story, "").prompt;
  const messages = renderPromptPlan(prompt);
  assert.equal(messages.length, 3);
  assert.equal(messages[0]!.role, "system");
  assert.match(messages[0]!.content, /CANONICAL STORY FACTS[\s\S]*Level: 5/);
  assert.doesNotMatch(messages[2]!.content, /Level: 5/);
  const fixedTexts = fixedPromptTexts(prompt);
  assert.ok(fixedTexts.every((text) => !text.includes("Level: 5")));
  assert.ok(fixedTexts.some((text) => text.includes("<story-data>")));
});

test("autoname: a tight prompt budget shrinks prose while facts ride whole", () => {
  const body = "Inventory:\n" + "moonstone, silver thread\n".repeat(120);
  const prose = `${"opening rain ".repeat(1_500)}MIDDLE-MARKER${" final fire".repeat(1_500)}`;
  const story = fixture([part("long", "Continue.", prose)], {
    facts: [fact("inventory", body)]
  });
  const roomy = renderPromptPlan(autonamePrompt(story, "").prompt);
  const tight = renderPromptPlan(autonamePrompt(story, "", 6_000).prompt);
  const roomyStory = storyData(roomy[2]!.content);
  const tightStory = storyData(tight[2]!.content);
  assert.ok(tightStory.length < roomyStory.length);
  assert.match(tightStory, /middle omitted for title generation/);
  assert.ok(tight[0]!.content.includes(body));
  assert.ok(!tight[2]!.content.includes(body));
});

test("autoname: cleans common model wrappers but rejects prose-sized answers", () => {
  assert.equal(normalizeGeneratedTitle('**Title: “Embers on Another Road”**'), "Embers on Another Road");
  assert.equal(normalizeGeneratedTitle("Here is a fitting title: The Glass Orchard"), "The Glass Orchard");
  assert.throws(
    () => normalizeGeneratedTitle("This is a very long explanation of why the story deserves a particular and unusually complicated literary title today"),
    GeneratedTitleError
  );
});

function fixture(nodes: StoryNode[], overrides: Partial<Story> = {}): Story {
  for (let index = 0; index < nodes.length; index += 1) {
    nodes[index]!.parentId = index === 0 ? null : nodes[index - 1]!.id;
    nodes[index]!.activeChildId = nodes[index + 1]?.id ?? null;
  }
  return {
    id: "story-1",
    title: "Untitled",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    facts: [],
    nodes,
    activeRootId: nodes[0]?.id ?? null,
    tags: [],
    recentNodeIds: [],
    ...overrides,
    chapterBreaks: overrides.chapterBreaks ?? []
  };
}

function part(id: string, instruction: string, text: string): StoryNode {
  return { id, parentId: null, instruction, text, model: "test", createdAt: "2025-01-01T00:00:00.000Z", activeChildId: null };
}

function fact(id: string, text: string): StoryFact {
  return {
    id,
    tag: null,
    states: [{ id: `${id}-state`, text, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" }],
    activation: "always",
    keys: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z"
  };
}

function storyData(prompt: string): string {
  return /<story-data>\n([\s\S]*)\n<\/story-data>/.exec(prompt)?.[1] ?? "";
}
