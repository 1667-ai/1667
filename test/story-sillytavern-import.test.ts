import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryService } from "../server/story-service.js";
import { MAX_TOTAL_CHARS, partsFromSillyTavernJsonl } from "../server/import-st.js";

test("StoryService.importSillyTavern imports a swipe as a sibling take, off the active storyline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "st-import-history-test-"));
  try {
    const service = StoryService.withoutDiagnostics({ dataDir: dir });
    await service.init();
    try {
      const jsonl = [
        JSON.stringify({ character_name: "Ashe", user_name: "You" }),
        JSON.stringify({ is_user: true, mes: "Which way do we go?" }),
        JSON.stringify({
          is_user: false,
          mes: "Ashe points down the low path.",
          swipe_id: 1,
          swipes: [
            "Ashe points at the cliff road.",
            "Ashe points down the low path.",
            "Ashe shrugs, unsure."
          ],
          swipe_info: [
            { send_date: "2024-01-01T00:00:00.000Z" },
            { send_date: "2024-01-01T00:05:00.000Z" },
            { send_date: "2024-01-01T00:10:00.000Z" }
          ]
        }),
        JSON.stringify({ is_user: true, mes: "Lead on." }),
        JSON.stringify({ is_user: false, mes: "She sets off without a word." })
      ].join("\n");

      const { payload, omittedAlternateSwipes } = await service.importSillyTavernWithReport(jsonl);
      assert.equal(omittedAlternateSwipes, 0);
      assert.deepEqual(payload.path.map(({ text }) => text), [
        "Ashe points down the low path.",
        "She sets off without a word."
      ]);
      assert.equal(payload.path[0]!.instruction, "Which way do we go?");

      // The chat has 4 takes: the active root, its two unpicked swipes
      // (siblings, also roots — a swipe replaces the first message, which has
      // no earlier take to attach under), and the second message's take.
      assert.equal(payload.nodes.length, 4);
      const root = payload.nodes.find(({ id }) => id === payload.activeRootId);
      assert.ok(root);
      assert.equal(root.preview, "Ashe points down the low path.");
      const roots = payload.nodes.filter(({ parentId }) => parentId === null);
      assert.equal(roots.length, 3);
      const alternateRoots = roots.filter(({ id }) => id !== root.id);
      assert.deepEqual(
        alternateRoots.map(({ preview }) => preview).sort(),
        ["Ashe points at the cliff road.", "Ashe shrugs, unsure."].sort()
      );
      assert.ok(alternateRoots.every(({ activeChildId }) => activeChildId === null));

      const child = payload.nodes.find(({ parentId }) => parentId === root.id);
      assert.ok(child);
      assert.equal(child.preview, "She sets off without a word.");
      assert.equal(root.activeChildId, child.id);
    } finally {
      await service.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("partsFromSillyTavernJsonl reuses the active take's instruction for every unselected swipe", () => {
  const jsonl = [
    JSON.stringify({ is_user: true, mes: "Begin." }),
    JSON.stringify({ is_user: false, mes: "Active take.", swipe_id: 0, swipes: ["Active take.", "Other take."] })
  ].join("\n");
  const imported = partsFromSillyTavernJsonl(jsonl);
  assert.equal(imported.parts.length, 2);
  assert.equal(imported.parts[0]!.text, "Active take.");
  assert.equal(imported.parts[0]!.instruction, "Begin.");
  assert.equal(imported.parts[1]!.text, "Other take.");
  assert.equal(imported.parts[1]!.instruction, "Begin.");
  assert.equal(imported.parts[1]!.active, false);
  assert.equal(imported.parts[1]!.parentIndex, null);
  assert.equal(imported.omittedAlternateSwipes, 0);
});

test("partsFromSillyTavernJsonl omits unselected swipes that do not fit the text budget without failing the import", () => {
  const bigActive = "x".repeat(MAX_TOTAL_CHARS - 10);
  const jsonl = [
    JSON.stringify({ is_user: true, mes: "Go." }),
    JSON.stringify({
      is_user: false,
      mes: bigActive,
      swipe_id: 0,
      swipes: [bigActive, "y".repeat(1000)]
    })
  ].join("\n");
  const imported = partsFromSillyTavernJsonl(jsonl);
  assert.equal(imported.parts.length, 1);
  assert.equal(imported.parts[0]!.text, bigActive);
  assert.equal(imported.omittedAlternateSwipes, 1);
});

test("partsFromSillyTavernJsonl never fails a later active message for a large early alternate", () => {
  // The whole active storyline must claim its budget before any alternate
  // does. A single-pass importer that spends budget message-by-message would
  // let this early alternate starve the second active message's own text.
  const activeOne = "Active one.";
  const activeTwo = "Active two.";
  const bigAlt = "x".repeat(MAX_TOTAL_CHARS - activeOne.length - 5);
  const jsonl = [
    JSON.stringify({ is_user: true, mes: "Go." }),
    JSON.stringify({
      is_user: false,
      mes: activeOne,
      swipe_id: 0,
      swipes: [activeOne, bigAlt]
    }),
    JSON.stringify({ is_user: true, mes: "Continue." }),
    JSON.stringify({ is_user: false, mes: activeTwo })
  ].join("\n");

  const imported = partsFromSillyTavernJsonl(jsonl);
  assert.deepEqual(imported.parts.map(({ text }) => text), [activeOne, activeTwo]);
  assert.equal(imported.omittedAlternateSwipes, 1);
});

test("partsFromSillyTavernJsonl charges an alternate's copied instruction to the text budget", () => {
  const instruction = "u".repeat(Math.floor(MAX_TOTAL_CHARS / 2) + 1);
  const jsonl = [
    JSON.stringify({ is_user: true, mes: instruction }),
    JSON.stringify({ is_user: false, mes: "A", swipe_id: 0, swipes: ["A", "B"] })
  ].join("\n");

  const imported = partsFromSillyTavernJsonl(jsonl);
  assert.deepEqual(imported.parts.map(({ text }) => text), ["A"]);
  assert.equal(imported.omittedAlternateSwipes, 1);
});

test("partsFromSillyTavernJsonl trusts swipe_id only when it names the active text, falling back by content", () => {
  const outOfBounds = partsFromSillyTavernJsonl([
    JSON.stringify({ is_user: true, mes: "Go." }),
    JSON.stringify({
      is_user: false,
      mes: "Chosen text",
      swipe_id: 99,
      swipes: ["Alt A", "Chosen text"]
    })
  ].join("\n"));
  assert.deepEqual(outOfBounds.parts.map(({ text }) => text), ["Chosen text", "Alt A"]);
  assert.equal(outOfBounds.omittedAlternateSwipes, 0);

  const mismatched = partsFromSillyTavernJsonl([
    JSON.stringify({ is_user: true, mes: "Go." }),
    JSON.stringify({
      is_user: false,
      mes: "Chosen text",
      swipe_id: 0,
      swipes: ["Alt A", "Chosen text"]
    })
  ].join("\n"));
  assert.deepEqual(mismatched.parts.map(({ text }) => text), ["Chosen text", "Alt A"]);
  assert.equal(mismatched.omittedAlternateSwipes, 0);

  // No swipes entry matches `mes` at all: which one is "active" is unknowable,
  // so no index is excluded and every swipe still imports.
  const noMatch = partsFromSillyTavernJsonl([
    JSON.stringify({ is_user: true, mes: "Go." }),
    JSON.stringify({
      is_user: false,
      mes: "Something else entirely",
      swipe_id: 5,
      swipes: ["Alt A", "Alt B"]
    })
  ].join("\n"));
  assert.deepEqual(noMatch.parts.map(({ text }) => text).sort(), ["Alt A", "Alt B", "Something else entirely"].sort());
  assert.equal(noMatch.omittedAlternateSwipes, 0);

  const loneNoMatch = partsFromSillyTavernJsonl([
    JSON.stringify({ is_user: true, mes: "Go." }),
    JSON.stringify({
      is_user: false,
      mes: "Chosen text",
      swipe_id: 4,
      swipes: ["Lone stale alternate"]
    })
  ].join("\n"));
  assert.deepEqual(loneNoMatch.parts.map(({ text }) => text), ["Chosen text", "Lone stale alternate"]);
  assert.equal(loneNoMatch.omittedAlternateSwipes, 0);
});
