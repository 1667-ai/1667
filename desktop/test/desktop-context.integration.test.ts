import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkerHost } from "../../host/worker-host.js";
import { storyApiFromWorkerTransport } from "../../client/worker-story-api.js";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import { supportsAssistantPrefill } from "../../shared/continuation-plan.js";
import { nextRequestEstimate } from "../../tui/src/request-projection.js";
import { projectRendererContext } from "../renderer-context.js";

type ContextDraftImages = Parameters<typeof projectRendererContext>[0]["draftImages"];

test("desktop next request matches the TUI plan with active settings, Facts, and notes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-context-"));
  const machineDir = path.join(directory, "machine");
  await mkdir(machineDir, { mode: 0o700 });
  const host = await createWorkerHost({ dataDir: path.join(directory, "project"), machineDir });
  const api = storyApiFromWorkerTransport(host.transport);
  try {
    const initial = await api.getSettings();
    assert.ok(initial.editable);
    await api.saveSettings({
      transportOperationId: crypto.randomUUID(), mutationId: createDurableMutationId(),
      expectedStateGeneration: initial.stateGeneration,
      document: applyBasicSettingsDraft(initial.document, {
        ...initial.effective, maxTokens: 512, contextWindow: 8192
      })
    });
    const settings = await api.getSettings();
    let story = await api.createStory("Context proof");
    story = await api.createNode(story.id, { parentId: null, text: "The lighthouse door opened." });
    story = await api.setAuthorsNote(story.id, "Keep the visitor unnamed.", 1);
    story = await api.setAuthorBrief(story.id, "Write in the past tense.");
    story = await api.createFact(story.id, { text: "The lighthouse is stone.", activation: "keyed", keys: ["lighthouse"] });
    story = await api.createFact(story.id, { text: "The mountain is cold.", activation: "keyed", keys: ["mountain"] });
    for (const [composerMode, direction] of [[
      "continue", ""
    ], [
      "continue", "The visitor returns."
    ], [
      "direct", "The visitor returns."
    ]] as const) {
      const projected = projectRendererContext({
        story, settings, composerMode, drafts: { composer: direction }, draftImages: [], stream: null, focusedPartId: null
      });
      assert.ok(projected);
      const tui = nextRequestEstimate(story, {
        operation: "continue", targetId: story.path.at(-1)!.id,
        instruction: direction,
        systemPrompt: settings.effectiveProse.systemPrompt,
        defaultContinueDirection: settings.activeWriting.defaultContinueDirection,
        assistantPrefill: supportsAssistantPrefill(settings.effectiveProse),
        contextWindow: settings.effectiveProse.contextWindow,
        maxTokens: settings.effectiveProse.maxTokens,
        continuationPromptLayout: settings.effectiveProseContinuationPromptLayout
      });
      assert.deepEqual(projected.messages, tui.messages);
      assert.equal(projected.promptTokens, tui.tokens);
      assert.equal(projected.contextWindow, 8192);
      assert.equal(projected.responseTokens, 512);
      assert.equal(projected.keptFacts, 1);
      const prompt = projected.messages.map((message) => message.content).join("\n");
      assert.match(prompt, /Keep the visitor unnamed/u);
      assert.match(prompt, /Write in the past tense/u);
      assert.match(prompt, /The lighthouse is stone/u);
      assert.doesNotMatch(prompt, /The mountain is cold/u);
      assert.equal((await api.countPromptTokens(projected.messages)).kind, "estimate");
    }

    const assertParity = (
      candidate: typeof story,
      composerMode: "continue" | "direct",
      direction: string,
      draftImages: ContextDraftImages
    ): void => {
      const projected = projectRendererContext({
        story: candidate, settings, composerMode, drafts: { composer: direction }, draftImages, stream: null, focusedPartId: null
      });
      assert.ok(projected);
      const tui = nextRequestEstimate(candidate, {
        operation: "continue", targetId: candidate.path.at(-1)?.id ?? null,
        instruction: direction,
        systemPrompt: settings.effectiveProse.systemPrompt,
        defaultContinueDirection: settings.activeWriting.defaultContinueDirection,
        assistantPrefill: supportsAssistantPrefill(settings.effectiveProse),
        contextWindow: settings.effectiveProse.contextWindow,
        maxTokens: settings.effectiveProse.maxTokens,
        continuationPromptLayout: settings.effectiveProseContinuationPromptLayout,
        draftImages: draftImages.map((image) => image.attachment)
      });
      assert.deepEqual(projected.messages, tui.messages);
      assert.equal(projected.promptTokens, tui.tokens);
    };

    const chapter = await api.createChapterBreak(story.id, story.path.at(-1)!.id, "Context chapter");
    assertParity(chapter.payload, "continue", "", []);
    const summarized = await api.summarizeChapter(story.id, chapter.breakId);
    assertParity(summarized, "continue", "", []);
    const staged = await api.stageStoryImage(story.id, "image/png", Uint8Array.from(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )));
    try {
      assertParity(story, "continue", "", [{ leaseId: staged.leaseId, attachment: staged.attachment }]);
    } finally {
      await api.releaseStoryImage(story.id, staged.leaseId);
    }
  } finally {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
