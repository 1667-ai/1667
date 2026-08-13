import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryService } from "../server/story-service.js";
import {
  MAX_SWIPE_RECORDS,
  MAX_TOTAL_CHARS,
  partsFromSillyTavernJsonl,
  sillyTavernFidelity
} from "../server/import-st.js";

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

test("StoryService persists group-chat speaker labels and reports their fidelity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "st-group-import-test-"));
  let service = StoryService.withoutDiagnostics({ dataDir: dir });
  try {
    await service.init();
    const jsonl = [
      JSON.stringify({ character_name: "Alice", user_name: "You" }),
      JSON.stringify({ is_user: true, name: "You", mes: "Begin." }),
      JSON.stringify({
        is_user: false,
        name: "Alice",
        mes: "Active.",
        swipe_id: 0,
        swipes: ["Active.", "Alternate."]
      }),
      JSON.stringify({ is_user: false, name: "Bob", mes: "Ready." })
    ].join("\n");

    const report = await service.importSillyTavernWithReport(jsonl);
    assert.equal(report.addedGroupChatSpeakerPrefixes, 3);
    assert.deepEqual(sillyTavernFidelity(report), [
      "3 group-chat speaker labels added to prose"
    ]);
    await service.dispose();

    service = StoryService.withoutDiagnostics({ dataDir: dir });
    await service.init();
    const reloaded = await service.loadStory(report.payload.id);
    const stored = await service.stories.loadHydrated(report.payload.id);
    assert.deepEqual(reloaded.path.map(({ text }) => text), [
      "Alice: Active.",
      "Bob: Ready."
    ]);
    assert.deepEqual(stored.nodes.map(({ text }) => text).sort(), [
      "Alice: Active.",
      "Alice: Alternate.",
      "Bob: Ready."
    ].sort());
  } finally {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("StoryService preserves headerless one-on-one narrator prose without group labels", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "st-narrator-import-test-"));
  const service = StoryService.withoutDiagnostics({ dataDir: dir });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  const report = await service.importSillyTavernWithReport([
    JSON.stringify({
      is_user: false,
      is_system: false,
      name: "System",
      mes: "Rain swept across the road.",
      extra: { type: "narrator" }
    }),
    JSON.stringify({ is_user: false, name: "Alice", mes: "{{char}} arrived quietly." })
  ].join("\n"));

  assert.equal(report.payload.title, "Alice (imported)");
  assert.equal(report.addedGroupChatSpeakerPrefixes, 0);
  assert.deepEqual(sillyTavernFidelity(report), []);
  assert.deepEqual((await service.loadStory(report.payload.id)).path.map(({ text }) => text), [
    "Rain swept across the road.",
    "Alice arrived quietly."
  ]);
});

test("partsFromSillyTavernJsonl keeps missing speakers in a group chat and reports the transformation", () => {
  const names = [
    "海莉", "威利", "阿比盖尔", "塞巴斯蒂安", "玛妮", "谢恩", "矮人", "莱纳斯",
    "肯特", "潘姆", "哈维", "格斯", "罗宾", "潘妮", "刘易斯", "皮埃尔", "科罗布斯", "法师"
  ];
  const messages = names.flatMap((name, index) => [
    { is_user: false, name, mes: `动作 ${index}。` },
    { is_user: false, name, mes: `${name} 的发言 ${index}。` }
  ]);
  const imported = partsFromSillyTavernJsonl([
    JSON.stringify({ name: "team", is_user: true, mes: "开始。" }),
    ...messages.map((message) => JSON.stringify(message))
  ].join("\n"));

  assert.equal(imported.parts.length, names.length * 2);
  assert.equal(imported.addedGroupChatSpeakerPrefixes, names.length);
  assert.deepEqual(imported.parts.slice(0, 4).map(({ text }) => text), [
    "海莉: 动作 0。",
    "海莉 的发言 0。",
    "威利: 动作 1。",
    "威利 的发言 1。"
  ]);
  assert.deepEqual(sillyTavernFidelity(imported), [
    "18 group-chat speaker labels added to prose"
  ]);
});

test("group-chat speaker prefixes apply to alternate swipes and one-on-one text stays unchanged", () => {
  const group = partsFromSillyTavernJsonl([
    JSON.stringify({ name: "team", is_user: true, mes: "Start." }),
    JSON.stringify({
      is_user: false,
      name: "Alice",
      mes: "Active.",
      swipe_id: 0,
      swipes: ["Active.", "Alternate."]
    }),
    JSON.stringify({ is_user: false, name: "Bob", mes: "Bob: already named." })
  ].join("\n"));
  assert.deepEqual(group.parts.map(({ text }) => text), [
    "Alice: Active.",
    "Bob: already named.",
    "Alice: Alternate."
  ]);
  assert.equal(group.addedGroupChatSpeakerPrefixes, 2);

  const oneOnOne = partsFromSillyTavernJsonl([
    JSON.stringify({ character_name: "A", user_name: "You" }),
    JSON.stringify({ is_user: true, name: "You", mes: "Start." }),
    JSON.stringify({ is_user: false, name: "A", mes: "Active." })
  ].join("\n"));
  assert.deepEqual(oneOnOne.parts.map(({ text }) => text), ["Active."]);
  assert.equal(oneOnOne.addedGroupChatSpeakerPrefixes, 0);
  assert.deepEqual(sillyTavernFidelity(oneOnOne), []);
});

test("discarded blank assistant records do not turn a one-on-one chat into a group", () => {
  const imported = partsFromSillyTavernJsonl([
    JSON.stringify({ character_name: "Alice" }),
    JSON.stringify({ is_user: false, name: "Alice", mes: "A quiet arrival." }),
    JSON.stringify({ is_user: false, name: "Bob", mes: "{{user}}" })
  ].join("\n"));

  assert.deepEqual(imported.parts.map(({ text }) => text), ["A quiet arrival."]);
  assert.equal(imported.addedGroupChatSpeakerPrefixes, 0);
  assert.deepEqual(sillyTavernFidelity(imported), []);
});

test("speaker spelling variants do not turn one-on-one chats into groups", () => {
  const casing = partsFromSillyTavernJsonl([
    JSON.stringify({ is_user: false, name: "Alice", mes: "First." }),
    JSON.stringify({ is_user: false, name: "alice", mes: "Second." })
  ].join("\n"));
  assert.deepEqual(casing.parts.map(({ text }) => text), ["First.", "Second."]);
  assert.equal(casing.addedGroupChatSpeakerPrefixes, 0);

  const normalization = partsFromSillyTavernJsonl([
    JSON.stringify({ is_user: false, name: "Élodie", mes: "Première." }),
    JSON.stringify({ is_user: false, name: "E\u0301LODIE", mes: "Deuxième." })
  ].join("\n"));
  assert.deepEqual(normalization.parts.map(({ text }) => text), ["Première.", "Deuxième."]);
  assert.equal(normalization.addedGroupChatSpeakerPrefixes, 0);

  const sharpS = partsFromSillyTavernJsonl([
    JSON.stringify({ is_user: false, name: "Straße", mes: "Erste." }),
    JSON.stringify({ is_user: false, name: "STRASSE", mes: "Zweite." })
  ].join("\n"));
  assert.deepEqual(sharpS.parts.map(({ text }) => text), ["Erste.", "Zweite."]);
  assert.equal(sharpS.addedGroupChatSpeakerPrefixes, 0);

  const finalSigma = partsFromSillyTavernJsonl([
    JSON.stringify({ is_user: false, name: "ΟΣ", mes: "Τρίτη." }),
    JSON.stringify({ is_user: false, name: "οσ", mes: "Τέταρτη." })
  ].join("\n"));
  assert.deepEqual(finalSigma.parts.map(({ text }) => text), ["Τρίτη.", "Τέταρτη."]);
  assert.equal(finalSigma.addedGroupChatSpeakerPrefixes, 0);
});

test("group-chat attribution follows expanded nonblank prose", () => {
  const imported = partsFromSillyTavernJsonl([
    JSON.stringify({ character_name: "Alice" }),
    JSON.stringify({ is_user: false, name: "Alice", mes: "{{char}} arrives." }),
    JSON.stringify({ is_user: false, name: "Alice", mes: "" }),
    JSON.stringify({
      is_user: false,
      name: "Alice",
      mes: "Alice waits.",
      swipe_id: 0,
      swipes: ["Alice waits.", " ", "{{user}}"]
    }),
    JSON.stringify({ is_user: false, name: "Bob", mes: "{{char}} arrives." })
  ].join("\n"));

  assert.deepEqual(imported.parts.map(({ text }) => text), [
    "Alice arrives.",
    "Alice waits.",
    "Bob arrives."
  ]);
  assert.equal(imported.addedGroupChatSpeakerPrefixes, 0);
  assert.equal(imported.omittedAlternateSwipes, 2);
});

test("Latin group-chat names match only at token boundaries", () => {
  const imported = partsFromSillyTavernJsonl([
    JSON.stringify({ is_user: false, name: "Ann", mes: "Planning tomorrow." }),
    JSON.stringify({ is_user: false, name: "Bob", mes: "Bob nods." })
  ].join("\n"));

  assert.deepEqual(imported.parts.map(({ text }) => text), [
    "Ann: Planning tomorrow.",
    "Bob nods."
  ]);
  assert.equal(imported.addedGroupChatSpeakerPrefixes, 1);
});

test("non-Latin alphabetic group-chat names match only at token boundaries", () => {
  const imported = partsFromSillyTavernJsonl([
    JSON.stringify({ is_user: false, name: "Анна", mes: "Жанна ответила." }),
    JSON.stringify({ is_user: false, name: "Борис", mes: "Борис кивнул." })
  ].join("\n"));

  assert.deepEqual(imported.parts.map(({ text }) => text), [
    "Анна: Жанна ответила.",
    "Борис кивнул."
  ]);
  assert.equal(imported.addedGroupChatSpeakerPrefixes, 1);
});

test("omitted blank active messages refund their character budget", () => {
  const imported = partsFromSillyTavernJsonl([
    JSON.stringify({ is_user: false, name: "Alice", mes: `Alice: ${"x".repeat(100)}` }),
    JSON.stringify({ is_user: false, name: "Alice", mes: `{{user}}${" ".repeat(MAX_TOTAL_CHARS)}` }),
    JSON.stringify({ is_user: false, name: "Bob", mes: "Bob: still imports." })
  ].join("\n"));

  assert.deepEqual(imported.parts.map(({ text }) => text), [
    `Alice: ${"x".repeat(100)}`,
    "Bob: still imports."
  ]);
  assert.equal(imported.addedGroupChatSpeakerPrefixes, 0);
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

test("partsFromSillyTavernJsonl refunds the budget for a blank unselected swipe", () => {
  const instruction = "u".repeat(Math.floor(MAX_TOTAL_CHARS / 2) - 10);
  const imported = partsFromSillyTavernJsonl([
    JSON.stringify({ is_user: true, mes: instruction }),
    JSON.stringify({
      is_user: false,
      mes: "Active",
      swipe_id: 0,
      swipes: ["Active", " ", "Valid"]
    })
  ].join("\n"));

  assert.deepEqual(imported.parts.map(({ text }) => text), ["Active", "Valid"]);
  assert.equal(imported.omittedAlternateSwipes, 1);
});

test("dropped trailing user turns consume no active or alternate text budget", () => {
  const imported = partsFromSillyTavernJsonl([
    JSON.stringify({
      is_user: false,
      mes: "Active",
      swipe_id: 0,
      swipes: ["Active", "Alternate"]
    }),
    JSON.stringify({ is_user: true, mes: "u".repeat(MAX_TOTAL_CHARS) })
  ].join("\n"));

  assert.deepEqual(imported.parts.map(({ text }) => text), ["Active", "Alternate"]);
  assert.equal(imported.droppedTrailingUserMessages, 1);
  assert.equal(imported.omittedAlternateSwipes, 0);
});

test("partsFromSillyTavernJsonl bounds nested swipe records", () => {
  const jsonl = JSON.stringify({
    is_user: false,
    mes: "Active",
    swipes: Array.from({ length: MAX_SWIPE_RECORDS + 1 }, () => "")
  });

  assert.throws(
    () => partsFromSillyTavernJsonl(jsonl),
    (error: unknown) => error instanceof Error
      && error.message === `Chat has more than ${MAX_SWIPE_RECORDS} swipe records — too large to import`
  );
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
