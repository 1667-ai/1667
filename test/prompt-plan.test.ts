import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { autonamePrompt } from "../server/autoname.js";
import { phraseRewritePlan, rewritePlan } from "../server/generation-prompts.js";
import { streamCompletion } from "../server/providers.js";
import { promptCacheBoundaries } from "../server/prompt-cache-breakpoints.js";
import { summaryTakePrompt } from "../server/summary-take.js";
import { continuationPlan, type ContinuationPlan } from "../shared/continuation-plan.js";
import {
  fixedPromptTexts,
  renderPromptPlan,
  type PromptPlan,
  type PromptTurn
} from "../shared/prompt-plan.js";
import type { GenerationSettings, Story, StoryNode } from "../shared/types.js";

test("prompt renderer preserves roles and concatenates blocks without invented separators", () => {
  const prompt: PromptPlan = {
    operation: "continue",
    turns: [
      {
        role: "system",
        blocks: [
          stable("author-brief", "Voice."),
          stable("operation-contract", "\nContract.")
        ]
      },
      {
        role: "user",
        blocks: [
          stable("source", "Source:"),
          volatile("request", " request.")
        ]
      }
    ]
  };

  assert.deepEqual(renderPromptPlan(prompt), [
    { role: "system", content: "Voice.\nContract." },
    { role: "user", content: "Source: request." }
  ]);
});

test("prompt renderer rejects malformed plans before provider transport", () => {
  const stableAfterVolatile: PromptPlan = {
    operation: "continue",
    turns: [
      { role: "user", blocks: [volatile("request", "now")] },
      { role: "assistant", blocks: [stable("source", "too late")] }
    ]
  };
  const emptyTurn: PromptPlan = {
    operation: "continue",
    turns: [{ role: "user", blocks: [] }]
  };
  const emptyBlock: PromptPlan = {
    operation: "continue",
    turns: [{ role: "user", blocks: [volatile("request", "")] }]
  };

  assert.throws(() => renderPromptPlan(stableAfterVolatile), /Stable prompt content cannot follow volatile/);
  assert.throws(() => renderPromptPlan(emptyTurn), /turns cannot be empty/);
  assert.throws(() => renderPromptPlan(emptyBlock), /blocks cannot be empty/);
});

test("continue renders the existing provider wire shape exactly", () => {
  const source = node("part-1", "Open the door.", "The latch clicked.");
  const prompt = continuationPlan(
    "Write vivid prose.",
    "CANONICAL FACTS",
    null,
    [source],
    "A stranger enters.",
    false,
    true,
    "ct-11111111",
    [],
    [source]
  ).prompt;

  assert.deepEqual(renderPromptPlan(prompt), [
    { role: "system", content: "Write vivid prose." },
    { role: "system", content: "CANONICAL FACTS" },
    {
      role: "system",
      content: "You are writing prose for an ongoing story. Use the final message to choose the operation. If the final message is an assistant message, it is an unfinished passage: continue directly from its exact final character, even when that character is in the middle of a word, and return only the new characters after that boundary. If the final message is a user message, follow its direction and write the next passage. In all cases, return only story text: no preamble, summary, explanation, commentary, headings, restart, retelling, or quotation of existing passages."
    },
    { role: "user", content: "Open the door." },
    { role: "assistant", content: "The latch clicked." },
    {
      role: "user",
      content: "Write the next passage of the story in response to the final user direction. Return only story prose: no summary, explanation, or commentary.\n\nA stranger enters."
    }
  ]);
});

test("continue omits a blank author brief instead of creating an empty block", () => {
  const source = node("part-1", "Open the door.", "The latch clicked.");
  const prompt = continuationPlan(
    " \n ",
    null,
    null,
    [source],
    "A stranger enters.",
    false,
    true,
    "ct-11111111",
    [],
    [source]
  ).prompt;

  assert.doesNotThrow(() => renderPromptPlan(prompt));
  assert.equal(
    prompt.turns.flatMap((turn) => turn.blocks).some((block) => block.kind === "author-brief"),
    false
  );
});

test("requested continuation defaults an empty instruction before rendering", () => {
  const source = node("part-1", "Open the door.", "The latch clicked.");
  const prompt = continuationPlan(
    "Voice.",
    null,
    null,
    [source],
    " \n ",
    false,
    true,
    "ct-11111111",
    [],
    [source]
  ).prompt;

  const last = renderPromptPlan(prompt).at(-1);
  assert.equal(last?.role, "user");
  // The contract now leads the same turn (issue #138 / PR #148), so the
  // default instruction is this message's tail, not its whole content.
  assert.equal(last?.content.endsWith("\n\nContinue the story."), true);
});

/**
 * Issue #138: a local server (llama.cpp/KoboldCpp) reuses its KV cache only
 * for an unchanged prompt *prefix*. The operation contract used to be the
 * third message, ahead of every story part, and its text depended on
 * whether the request continues a passage or starts a new part — so writing
 * ordinarily, alternating between the two, rewrote a message ahead of the
 * whole story and forced a full reprocess. These tests cover the property
 * that actually fixes that: the two requests share an unchanged prefix
 * through the last story part, regardless of which way the request goes.
 */
test("continuing a passage and starting a new part share a byte-identical prompt prefix through the last story part", () => {
  const parts = [
    node("part-1", "Open the door.", "The latch clicked."),
    node("part-2", "Cross the threshold.", "Dust motes hung in the still, cold air")
  ];
  const continuePrefill = continuationPlan(
    "Write vivid prose.", "CANONICAL FACTS", null, parts, "unused for a continuation",
    true, true, "ct-continue", [], parts
  );
  const continueEcho = continuationPlan(
    "Write vivid prose.", "CANONICAL FACTS", null, parts, "unused for a continuation",
    true, false, "ct-continue", [], parts
  );
  const newPart = continuationPlan(
    "Write vivid prose.", "CANONICAL FACTS", null, parts, "A stranger enters.",
    false, true, "ct-new", [], parts
  );

  assert.deepEqual(prefixThroughLastPart(continuePrefill), prefixThroughLastPart(newPart));
  assert.deepEqual(prefixThroughLastPart(continueEcho), prefixThroughLastPart(newPart));
});

test("the shared prefix survives an Author's Note too, at every part count", () => {
  for (const count of [1, 2, 3, 5]) {
    const parts = Array.from({ length: count }, (_, index) =>
      node(`part-${index + 1}`, `Direction ${index + 1}.`, `Passage ${index + 1} prose`)
    );
    const authorsNote = { text: "Keep the danger quiet.", depth: 1 };
    const continuePrefill = continuationPlan(
      "Voice.", "Facts.", authorsNote, parts, "unused", true, true, "ct-continue", [], parts
    );
    const newPart = continuationPlan(
      "Voice.", "Facts.", authorsNote, parts, "Go on.", false, true, "ct-new", [], parts
    );
    assert.deepEqual(
      prefixThroughLastPart(continuePrefill),
      prefixThroughLastPart(newPart),
      `part count ${count}`
    );
  }
});

/**
 * Issue #176: a continuation went out with no directive at all. PR #148 moved
 * the operation contract into the final user turn, and the assistant-prefill
 * path has no final user turn — it ends on the story's own unfinished
 * assistant message — so that path silently shipped the Author Brief, the
 * Facts, and nothing else. Every `openai-compatible` connection that is not
 * OpenAI or Azure takes that path, which is every local server.
 *
 * The guard is stated over the whole mode matrix rather than the three shapes
 * that happened to exist, because the regression was invisible exactly where
 * no case had been written. A mode that carries no directive is the defect,
 * whatever combination produced it.
 */
test("every continuation mode carries a directive, and the mode-dependent contract is sent wherever a turn can hold it", () => {
  const parts = [node("part-1", "Open the door.", "The latch clicked, then")];
  const image = {
    objectId: "obj-1",
    mediaType: "image/png" as const,
    width: 8,
    height: 8,
    byteLength: 64
  };
  const contracts = (prompt: PromptPlan): string[] =>
    prompt.turns.flatMap((turn) => turn.blocks)
      .filter((block) => block.kind === "operation-contract")
      .map((block) => ("text" in block ? block.text : ""));

  for (const appendLast of [true, false]) {
    for (const assistantPrefill of [true, false]) {
      for (const withImage of [true, false]) {
        for (const brief of ["Voice.", " "]) {
          const label = `append=${appendLast} prefill=${assistantPrefill} image=${withImage} brief=${brief.trim().length > 0}`;
          const plan = continuationPlan(
            brief, null, null, parts, "A stranger enters.",
            appendLast, assistantPrefill, "ct-matrix", [], parts,
            withImage ? [image] : []
          );
          const found = contracts(plan.prompt);

          // The invariant the regression broke: never zero.
          assert.ok(found.length >= 1, `no operation contract at all: ${label}`);
          assert.ok(
            found.some((text) => text.startsWith("You are writing prose for an ongoing story.")),
            `the mode-independent contract is missing: ${label}`
          );

          // A prefilled continuation of a real passage ends on the assistant
          // message, so nothing can follow it: the mode-dependent half has
          // nowhere to sit, and the prefill mechanism enforces what it says.
          // An image forces a new-passage turn, which can carry it again.
          const prefillContinuesPassage = appendLast && assistantPrefill && !withImage;
          assert.equal(
            found.length,
            prefillContinuesPassage ? 1 : 2,
            `unexpected contract count: ${label}`
          );
        }
      }
    }
  }
});

/**
 * The other half of #176: the prelude must not go back to carrying text that
 * changes with the mode. That is what PR #148 removed, because a prelude that
 * differs between continuing a passage and starting a new part invalidates a
 * local server's KV cache on every switch — the whole point of issue #138.
 * Restoring the directive is only correct while this stays true.
 */
test("the prompt prefix through the last story part is byte-identical across continuation modes", () => {
  const parts = [node("part-1", "Open the door.", "The latch clicked, then")];
  const prefixes = [true, false].flatMap((appendLast) =>
    [true, false].map((assistantPrefill) => {
      const rendered = renderPromptPlan(continuationPlan(
        "Voice.", "CANONICAL FACTS", null, parts, "A stranger enters.",
        appendLast, assistantPrefill, "ct-prefix", [], parts
      ).prompt);
      // Everything up to and including the story's last assistant message.
      const lastPart = rendered.map((message) => message.role).lastIndexOf("assistant");
      return JSON.stringify(rendered.slice(0, lastPart + 1));
    })
  );

  for (const prefix of prefixes) assert.equal(prefix, prefixes[0]);
});

/**
 * PR #148 review finding: `appendOperationContract` used to emit the
 * contract as its own `role: "system"` turn placed after the story parts —
 * so a minimal prompt (no Author Brief, no Facts) rendered as
 * `user, assistant, system, user`. Many llama.cpp/KoboldCpp chat templates
 * (Gemma's among the strictest) accept a system message only first and then
 * enforce strict user/assistant alternation; a system turn appearing after
 * an assistant turn makes those templates fail to render or mis-serialize —
 * exactly the class of local server issue #138 exists to help, so the fix
 * traded away compatibility for a cache win. `operationContractBlock` now
 * folds the contract into the final turn instead, as a leading block rather
 * than a message of its own, so no system turn ever follows an assistant
 * turn. This is the general property, checked on the rendered plan, not a
 * spot check of one shape.
 */
test("no system-role message ever follows an assistant message, with or without an Author Brief and Facts", () => {
  const parts = [
    node("part-1", "Open the door.", "The latch clicked."),
    node("part-2", "Cross the threshold.", "Dust motes hung in the still, cold air")
  ];

  const assertNoSystemAfterAssistant = (prompt: PromptPlan, label: string): void => {
    let sawAssistant = false;
    for (const message of renderPromptPlan(prompt)) {
      if (message.role === "assistant") {
        sawAssistant = true;
        continue;
      }
      assert.equal(
        sawAssistant && message.role === "system",
        false,
        `${label}: a system message followed an assistant message`
      );
    }
  };

  for (const [brief, facts] of [
    ["Write vivid prose.", "CANONICAL FACTS"],
    ["", null]
  ] as const) {
    const label = `brief=${JSON.stringify(brief)} facts=${JSON.stringify(facts)}`;
    const direct = continuationPlan(
      brief, facts, null, parts, "A stranger enters.", false, true, "ct-new", [], parts
    );
    const boundaryEcho = continuationPlan(
      brief, facts, null, parts, "unused", true, false, "ct-echo", [], parts
    );
    const continuePrefill = continuationPlan(
      brief, facts, null, parts, "unused", true, true, "ct-prefill", [], parts
    );
    assertNoSystemAfterAssistant(direct.prompt, `${label} direct`);
    assertNoSystemAfterAssistant(boundaryEcho.prompt, `${label} boundary echo`);
    assertNoSystemAfterAssistant(continuePrefill.prompt, `${label} continue (prefill)`);
  }
});

test("continuation inserts one late Author's Note before the final part at every part count", () => {
  for (const count of [0, 1, 2, 3, 5]) {
    const parts = Array.from({ length: count }, (_, index) =>
      node(`part-${index + 1}`, `Direction ${index + 1}.`, `Passage ${index + 1}.`)
    );
    const withNote = continuationPlan(
      "Voice.",
      "Facts.",
      { text: "Guide the next passage.", depth: 1 },
      parts,
      "Request.",
      false,
      true,
      "ct-note",
      [],
      parts
    );
    const noteIndexes = withNote.entries
      .map((entry, index) => entry.category === "note" ? index : -1)
      .filter((index) => index >= 0);
    // The prelude is three entries: Author Brief, Facts, and the
    // mode-independent contract (issue #176). The mode-dependent half does
    // not ride as an entry of its own (PR #148) — it folds into whichever
    // turn already carries the final instruction or boundary echo
    // (`operationContractBlock`), so it never shifts the note's index,
    // including at zero parts.
    assert.deepEqual(noteIndexes, [3 + Math.max(0, count - 1) * 2]);
    const noteIndex = noteIndexes[0]!;
    assert.equal(withNote.entries[noteIndex]!.turn.role, "system");
    assert.equal(withNote.entries[noteIndex + 1]!.turn.role, "user");
    assert.equal((withNote.entries[noteIndex] as { partsAfterNote: number }).partsAfterNote, count === 0 ? 0 : 1);
    assert.deepEqual(
      withNote.prompt.turns,
      withNote.entries.map((entry) => entry.turn)
    );
    assert.equal(fixedPromptTexts(withNote.prompt).includes("Guide the next passage."), false);

    const noNote = continuationPlan(
      "Voice.", "Facts.", null, parts, "Request.", false, true, "ct-note", [], parts
    );
    // The trailing operation contract is never itself a candidate (it rides
    // after the deepest one on purpose — see `operationContractBlock`), so
    // it never enters this comparison at all: what is left lines up exactly
    // as it did before the contract moved.
    assert.deepEqual(
      promptCacheBoundaries(withNote.prompt),
      count === 0
        ? promptCacheBoundaries(noNote.prompt)
        : promptCacheBoundaries(noNote.prompt).slice(0, -1)
    );
    assert.deepEqual(
      continuationPlan(
        "Voice.", "Facts.", { text: "  \n\t", depth: 1 }, parts, "Request.", false, true, "ct-note", [], parts
      ),
      noNote
    );
  }
});

test("continuation places the Author's Note deeper by depth, and clamps past the available parts", () => {
  const parts = Array.from({ length: 4 }, (_, index) =>
    node(`part-${index + 1}`, `Direction ${index + 1}.`, `Passage ${index + 1}.`)
  );
  // Depth counts story parts, not entries: each part is a user/assistant
  // pair, so depth 2 lands the note before the 3rd part. The three-entry
  // prelude (Author Brief, Facts, mode-independent contract) sets the base
  // offset; the mode-dependent half rides at the end and never shifts these.
  for (const [depth, expectedIndex, expectedEffectiveDepth] of [
    [1, 9, 1],
    [2, 7, 2],
    [4, 3, 4],
    [10, 3, 4] // past the available parts: clamps to the start, right after the prelude.
  ] as const) {
    const plan = continuationPlan(
      "Voice.", "Facts.", { text: "Guide it.", depth }, parts, "Request.", false, true, "ct-depth", [], parts
    );
    const noteIndex = plan.entries.findIndex((entry) => entry.category === "note");
    assert.equal(noteIndex, expectedIndex, `depth ${depth}`);
    assert.equal(plan.entries[noteIndex + 1]!.turn.role, "user");
    assert.equal(
      (plan.entries[noteIndex] as { partsAfterNote: number }).partsAfterNote,
      expectedEffectiveDepth,
      `depth ${depth} effective`
    );
  }
});

test("stable rendered-prefix hashes are golden for every generation operation", () => {
  const story = fixture("Before the lantern dimmed, rain crossed the glass. Dawn waited beyond it.");
  const target = "rain crossed the glass";
  const start = story.nodes[0]!.text.indexOf(target);
  const plans = {
    continue: continuationPlan(
      "Voice.", "Facts.", null, story.nodes, "Turn north.", false, true, "ct-11111111", [], story.nodes
    ).prompt,
    rewrite: rewritePlan({
      story,
      facts: "Facts.",
      partId: story.nodes[0]!.id,
      start,
      end: start + target.length,
      expected: target,
      instruction: "Make the weather threatening.",
      lengthTarget: "Length: four words.",
      authorBrief: "Voice.",
      tag: "rw-11111111",
      assistantPrefill: false
    }).prompt,
    phrase: phraseRewritePlan({
      story,
      facts: "Facts.",
      partId: story.nodes[0]!.id,
      start,
      end: start + target.length,
      expected: target,
      instruction: "Make the weather threatening.",
      lengthTarget: "Length: four words.",
      authorBrief: "Voice.",
      tag: "rw-11111111"
    }).prompt,
    title: autonamePrompt(story, "Voice.", 24_000, "Facts.").prompt,
    summary: summaryTakePrompt(story.title, story.nodes, 512, "11111111")
  };

  assert.deepEqual(Object.fromEntries(
    Object.entries(plans).map(([operation, prompt]) => [operation, prefixHash(prompt)])
  ), {
    // Changed by issue #176, which returned the mode-independent contract to
    // the prelude. Only `continue` moves: no other operation shares it.
    continue: "b99dd1db41be3369faa1c3b0a9de3583e7ed3cae36bb8b5e7c499d89e756e116",
    rewrite: "915a92f74c89251f1a90cae595e7682f7f4287a1bc273ac9e2fc01099cbd4462",
    phrase: "928f1145fa90b9f398b67be8eb84164fdc17ce58b2e85704505f322ff8099752",
    title: "8ce79bf5ea50fb067d4a53a1f228b0df1b2a3c4ff6f4b698c781d00cbf3c8d72",
    summary: "d54ee9ebf17625fe1340410a18e8d2df4ace4c9a61bfd52d773e72bcc8133dc9"
  });
});

test("request changes and random tags affect only volatile suffixes", () => {
  const story = fixture("The bell rang once. Its bronze note crossed the empty square.");
  const expected = "bronze note";
  const start = story.nodes[0]!.text.indexOf(expected);
  const pairs: Array<readonly [PromptPlan, PromptPlan, string, string]> = [
    [
      continuationPlan("Voice.", null, null, story.nodes, "Continue.", true, false, "ct-aaaaaaaa", [], story.nodes).prompt,
      continuationPlan("Voice.", null, null, story.nodes, "Continue.", true, false, "ct-bbbbbbbb", [], story.nodes).prompt,
      "ct-aaaaaaaa",
      "ct-bbbbbbbb"
    ],
    [
      rewritePlan({
        story, facts: null, partId: story.nodes[0]!.id, start, end: start + expected.length, expected,
        instruction: "Make it ominous.", lengthTarget: "Length: two words.", authorBrief: "Voice.",
        tag: "rw-aaaaaaaa", assistantPrefill: false
      }).prompt,
      rewritePlan({
        story, facts: null, partId: story.nodes[0]!.id, start, end: start + expected.length, expected,
        instruction: "Make it ominous.", lengthTarget: "Length: two words.", authorBrief: "Voice.",
        tag: "rw-bbbbbbbb", assistantPrefill: false
      }).prompt,
      "rw-aaaaaaaa",
      "rw-bbbbbbbb"
    ],
    [
      phraseRewritePlan({
        story, facts: null, partId: story.nodes[0]!.id, start, end: start + expected.length, expected,
        instruction: "Make it ominous.", lengthTarget: "Length: two words.", authorBrief: "Voice.",
        tag: "rw-aaaaaaaa"
      }).prompt,
      phraseRewritePlan({
        story, facts: null, partId: story.nodes[0]!.id, start, end: start + expected.length, expected,
        instruction: "Make it ominous.", lengthTarget: "Length: two words.", authorBrief: "Voice.",
        tag: "rw-bbbbbbbb"
      }).prompt,
      "rw-aaaaaaaa",
      "rw-bbbbbbbb"
    ],
    [
      summaryTakePrompt(story.title, story.nodes, 512, "aaaaaaaa"),
      summaryTakePrompt(story.title, story.nodes, 512, "bbbbbbbb"),
      "aaaaaaaa",
      "bbbbbbbb"
    ]
  ];

  for (const [first, second, firstTag, secondTag] of pairs) {
    assert.equal(stablePrefix(first), stablePrefix(second));
    assert.notEqual(volatileSuffix(first), volatileSuffix(second));
    assertNonceIsVolatile(first, firstTag);
    assertNonceIsVolatile(second, secondTag);
  }

  const firstInstruction = continuationPlan(
    "Voice.", null, null, story.nodes, "Turn north.", false, true, "ct-unused", [], story.nodes
  ).prompt;
  const secondInstruction = continuationPlan(
    "Voice.", null, null, story.nodes, "Turn south.", false, true, "ct-unused", [], story.nodes
  ).prompt;
  assert.equal(stablePrefix(firstInstruction), stablePrefix(secondInstruction));

  const changedFacts = continuationPlan(
    "Voice.", "Changed facts.", null, story.nodes, "Turn north.", false, true, "ct-unused", [], story.nodes
  ).prompt;
  assert.notEqual(stablePrefix(firstInstruction), stablePrefix(changedFacts));
});

test("all declared cache candidates are stable and each operation ends its stable prefix at one", () => {
  const story = fixture("Rain crossed the courtyard.");
  const plans = [
    continuationPlan("Voice.", null, null, story.nodes, "Continue.", false, true, "ct-test", [], story.nodes).prompt,
    rewritePlan({
      story, facts: null, partId: story.nodes[0]!.id, start: 0, end: 4, expected: "Rain",
      instruction: "Change it.", lengthTarget: "Length: one word.", authorBrief: "Voice.",
      tag: "rw-aaaaaaaa", assistantPrefill: false
    }).prompt,
    autonamePrompt(story, "Voice.").prompt,
    summaryTakePrompt(story.title, story.nodes, 512, "aaaaaaaa")
  ];

  for (const prompt of plans) {
    const blocks = prompt.turns.flatMap((turn) => turn.blocks);
    const candidates = blocks.filter((block) => block.boundaryAfter === "candidate");
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every((block) => block.stability === "stable"));
    const lastStable = blocks.findLast((block) => block.stability === "stable");
    if (lastStable?.kind === "operation-contract") {
      // A continuation's trailing operation contract (issue #138) is stable
      // but deliberately not itself a candidate: unlike a story part, its
      // hash is recomputed over the whole growing story on every request,
      // so offering it as the deepest OpenAI breakpoint would make the
      // previous request's remembered breakpoint unfindable the moment the
      // story grows by even one part (see `appendOperationContract`). The
      // prompt's real stable prefix still ends at a candidate; the contract
      // is just small, always-fresh overhead riding after it.
      assert.notEqual(candidates.at(-1), undefined);
    } else {
      assert.equal(lastStable?.boundaryAfter, "candidate");
    }
  }
});

test("dry-run rewrite reads the semantic selection, not delimiter-like source prose", async () => {
  const collision = "<rw-deadbeef>bogus</rw-deadbeef>";
  const selected = "real target has four words";
  const story = fixture(`${collision} Before ${selected}. After.`);
  const start = story.nodes[0]!.text.indexOf(selected);
  const prompt = rewritePlan({
    story,
    facts: null,
    partId: story.nodes[0]!.id,
    start,
    end: start + selected.length,
    expected: selected,
    instruction: "Refresh it.",
    lengthTarget: "Length: five words.",
    authorBrief: "Voice.",
    tag: "rw-deadbeef",
    assistantPrefill: false
  }).prompt;
  let output = "";
  for await (const delta of streamCompletion(dryRunSettings(), prompt, new AbortController().signal)) {
    output += delta;
  }

  assert.match(output, /^placeholder prose from dry-run mode/);
  assert.match(output, /\[\[end-rw-deadbeef\]\]$/);
});

/** The rendered messages through and including the last story part — the
 *  segment a local server's KV cache needs held byte-identical across a
 *  continue-a-passage request and a start-a-new-part request for the same
 *  story (issue #138). `entries` and `prompt.turns` stay index-aligned
 *  (`continuationResult` builds `prompt.turns` as `entries.map(e => e.turn)`),
 *  so the last entry that carries a `partId` names exactly where that
 *  segment ends, regardless of what either request appends after it. */
function prefixThroughLastPart(plan: ContinuationPlan): unknown {
  const lastPartIndex = plan.entries.findLastIndex((entry) => entry.partId !== undefined);
  if (lastPartIndex === -1) throw new Error("expected at least one story part entry");
  return renderPromptPlan(plan.prompt).slice(0, lastPartIndex + 1);
}

function stable(
  kind: "author-brief" | "facts" | "operation-contract" | "source",
  text: string
) {
  return { stability: "stable" as const, kind, text, boundaryAfter: "candidate" as const };
}

function volatile(
  kind: "request" | "selection" | "boundary" | "completion-marker",
  text: string
) {
  return { stability: "volatile" as const, kind, text, boundaryAfter: "none" as const };
}

function stablePrefix(prompt: PromptPlan): string {
  const turns: Array<{ role: PromptTurn["role"]; content: string }> = [];
  let reachedVolatile = false;
  for (const turn of prompt.turns) {
    let content = "";
    for (const block of turn.blocks) {
      if (block.stability === "volatile") {
        reachedVolatile = true;
        continue;
      }
      assert.equal(reachedVolatile, false, "stable content followed volatile content");
      // These fixtures never build an image block, so this never fires; it
      // exists only to narrow `block` back to one with `.text`.
      if (block.kind === "image") continue;
      content += block.text;
    }
    if (content.length > 0) turns.push({ role: turn.role, content });
  }
  return JSON.stringify(turns);
}

function volatileSuffix(prompt: PromptPlan): string {
  return prompt.turns.flatMap((turn) => turn.blocks)
    .flatMap((block) => block.stability === "volatile" && block.kind !== "image" ? [block.text] : [])
    .join("");
}

function prefixHash(prompt: PromptPlan): string {
  return createHash("sha256").update(stablePrefix(prompt)).digest("hex");
}

function assertNonceIsVolatile(prompt: PromptPlan, nonce: string): void {
  const containing = prompt.turns.flatMap((turn) => turn.blocks)
    .flatMap((block) => block.kind !== "image" && block.text.includes(nonce) ? [block] : []);
  assert.ok(containing.length > 0, `missing nonce ${nonce}`);
  assert.ok(containing.every((block) => block.stability === "volatile"), `${nonce} escaped the volatile suffix`);
}

function fixture(text: string): Story {
  const source = node("part-1", "Begin.", text);
  return {
    id: "story-1",
    title: "The Rain Bell",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    facts: [],
    nodes: [source],
    activeRootId: source.id,
    tags: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
}

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

function dryRunSettings(): GenerationSettings {
  return {
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 128,
    systemPrompt: "Voice.",
    contextWindow: null
  };
}
