import { createRendererApi } from "../../renderer-runtime.js";
import { applyBasicSettingsDraft } from "../../../shared/settings-basic-draft.js";
import { createDurableMutationId } from "../../../shared/durable-mutation-id.js";
import type { StoryApi } from "../../../client/api.js";

declare global {
  interface Window {
    contractApi: StoryApi;
    contractReady: boolean;
    contractError?: string;
    runClientContract(): Promise<void>;
    setFailingProvider(failing: boolean): Promise<void>;
    contractStreaming?: boolean;
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function refuses(operation: Promise<unknown>, code: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    check(error !== null && typeof error === "object" && "code" in error
      && error.code === code, `Expected ${code}, received ${String(error)}`);
    return;
  }
  throw new Error(`Expected ${code}, but the request succeeded`);
}

window.setFailingProvider = async (failing) => {
  const api = window.contractApi;
  const settings = await api.getSettings();
  check(settings.editable, "Settings must be editable");
  await api.saveSettings({
    transportOperationId: crypto.randomUUID(), mutationId: createDurableMutationId(),
    expectedStateGeneration: settings.stateGeneration,
    document: applyBasicSettingsDraft(settings.document, {
      ...settings.effective,
      provider: failing ? "openai-compatible" : "dry-run",
      baseUrl: "https://127.0.0.1:1/v1", model: "missing", apiKeyEnv: null
    })
  });
};

window.runClientContract = async () => {
  const api = window.contractApi;
  check(!("process" in window) && !("Buffer" in window) && !("require" in window),
    "The Renderer must have browser globals only");
  const defaults = await api.getSettings();
  check(defaults.editable, "Fresh settings must be editable");
  await api.saveSettings({
    transportOperationId: crypto.randomUUID(), mutationId: createDurableMutationId(),
    expectedStateGeneration: defaults.stateGeneration,
    document: applyBasicSettingsDraft(defaults.document, { ...defaults.effective, maxTokens: 768 })
  });
  const settings = await api.getSettings();
  check(settings.effective.maxTokens === 768, "Settings did not persist");
  check((await api.checkModelServer(settings.effective)).state === "ready", "Provider check failed");
  check((await api.discoverModels(settings.effective)).models.length === 0, "Dry-run model discovery changed");
  check((await api.probeContextWindow(settings.effective)).contextWindow === null, "Dry-run context probe changed");
  check((await api.countPromptTokens([{ role: "user", content: "Hello" }])).kind === "estimate",
    "Dry-run token count must be an estimate");

  let story = await api.createStory("Desktop contract");
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 32;
  const drawing = canvas.getContext("2d")!;
  drawing.fillStyle = "#c55a20";
  drawing.fillRect(0, 0, 64, 32);
  const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("Image fixture could not be encoded")), "image/png"));
  const staged = await api.stageStoryImage(story.id, "image/png", new Uint8Array(await image.arrayBuffer()));
  check(staged.attachment.width === 64 && staged.attachment.height === 32,
    "The Electron image child did not normalize the attachment");
  await api.releaseStoryImage(story.id, staged.leaseId);
  await api.releaseStoryImage(story.id, staged.leaseId);
  check((await api.listStories()).some(({ id }) => id === story.id), "Created story is missing");
  story = await api.renameStory(story.id, "Desktop renamed");
  check((await api.loadStory(story.id)).title === "Desktop renamed", "Rename did not persist");
  story = await api.createNode(story.id, { parentId: null, text: "The red door opened." });
  story = await api.editNode(story.id, story.path[0]!, { text: "The blue door opened." });
  const root = story.path[0]!;
  story = await api.takeFromCut(story.id, root.id, { offset: 8, expected: "The blue" });
  check(story.path[0]?.text === "The blue", "Cut did not preserve the selected prefix");
  story = await api.switchLine(story.id, root.id, { stopAtNode: true });
  story = await api.putBookmark(story.id, root.id, "Opening", "");
  check(story.tags[0]?.name === "Opening", "Tag was not saved");
  story = await api.deleteBookmark(story.id, root.id);
  check(story.tags.length === 0, "Tag was not removed");

  story = await api.createFact(story.id, { text: "The door is blue.", activation: "keyed", keys: ["door"] });
  const fact = story.facts[0]!;
  story = await api.patchFact(story.id, fact.id, { text: "The door is iron.", priority: "high" });
  const firstState = story.facts[0]?.states[0];
  check(firstState && "text" in firstState && firstState.text === "The door is iron.", "Fact edit did not persist");
  check(api.createFactState && api.patchFactState && api.deleteFactState, "Fact State methods are missing");
  story = await api.createFactState(story.id, fact.id, { anchorPartId: root.id, text: "The door is brass." });
  const state = story.facts[0]!.states.find(({ id }) => id !== fact.id)!;
  story = await api.patchFactState(story.id, fact.id, state.id, { text: "The door is open." });
  check(story.facts[0]!.states.some((state) => "text" in state && state.text === "The door is open."), "Fact State edit failed");
  story = await api.deleteFactState(story.id, fact.id, state.id);
  story = await api.createFact(story.id, { text: "A second fact." });
  const secondFact = story.facts[1]!;
  story = await api.reorderFact(story.id, secondFact.id, 0);
  check(story.facts[0]?.id === secondFact.id, "Fact order did not change");
  story = await api.setFactsBudget(story.id, 4000);
  check(story.factsBudgetTokens === 4000, "Fact budget was not saved");
  story = await api.deleteFact(story.id, secondFact.id);
  story = await api.deleteFact(story.id, fact.id);
  check(story.facts.length === 0, "Facts were not removed");

  const chapter = await api.createChapterBreak(story.id, root.id, "Chapter Two");
  story = await api.renameChapterBreak(story.id, chapter.breakId, "The Visitor");
  check(story.chapterBreaks[0]?.title === "The Visitor", "Chapter rename failed");
  story = await api.createNode(story.id, { parentId: root.id, text: "A knock rattled the frame." });
  const second = story.path[1]!;
  story = await api.moveChapterBreak(story.id, chapter.breakId, second.id);
  check(story.chapterBreaks[0]?.parentPartId === second.id, "Chapter move failed");
  story = await api.moveChapterBreak(story.id, chapter.breakId, root.id);
  check(story.chapterBreaks[0]?.parentPartId === root.id, "Chapter move back failed");
  story = await api.deleteNode(story.id, second.id, 1);
  story = await api.summarizeChapter(story.id, chapter.breakId);
  const summary = story.nodes.find((node) => node.chapterBreakId === chapter.breakId)!;
  check(summary.text !== undefined, "Chapter summary was not hydrated");
  story = await api.editChapterSummary(story.id, summary.id, "A visitor opens the door.", summary.text);
  check(story.nodes.find(({ id }) => id === summary.id)?.text === "A visitor opens the door.", "Summary edit failed");
  const removed = await api.removeChapterBreak(story.id, chapter.breakId);
  check(removed.payload.chapterBreaks.length === 0, "Chapter removal failed");
  story = await api.restoreChapterBreak(story.id, chapter.breakId, removed.removed);
  check(story.chapterBreaks[0]?.id === chapter.breakId, "Chapter restore failed");

  const generated: string[] = [];
  const result = await api.continueStory(story.id, "A visitor arrives.", "desktop-contract-continue",
    { parentId: root.id }, (text) => generated.push(text), new AbortController().signal);
  check(result && generated.join("").length > 0, "Generation did not cross the desktop port");
  story = result.payload;
  const rewritten: string[] = [];
  await api.rewriteNode(story.id, root.id,
    { start: 4, end: 8, expected: "blue", instruction: "Change the color." },
    (text) => rewritten.push(text), new AbortController().signal);
  story = await api.loadStory(story.id);
  check(rewritten.length > 0 && story.path[0]!.text.includes("placeholder"), "Rewrite did not persist");
  const summaryId = await api.createSummaryTake(story.id, { nodeId: story.path.at(-1)!.id },
    () => {}, new AbortController().signal, { onPayload: (payload) => { story = payload; } });
  check(summaryId !== null, "Summary take did not complete");
  story = await api.switchLine(story.id, root.id);

  const cancel = new AbortController();
  const arrived: string[] = [];
  const cancelled = await api.continueStory(story.id, "Stop this generation.", "desktop-contract-stop",
    { parentId: story.path.at(-1)!.id }, (text) => { arrived.push(text); cancel.abort(); }, cancel.signal);
  check(cancelled === null && arrived.join("").length > 0, "Stop did not retain arrived text");
  story = await api.loadStory(story.id);
  story = await api.createNode(story.id, {
    parentId: story.path.at(-1)!.id, text: arrived.join(""), genId: "desktop-contract-stop"
  });
  check(story.path.at(-1)?.genId === "desktop-contract-stop", "Stopped generation lost its attribution");
  const found = await api.searchStories({ query: "placeholder", scope: "tree", storyId: story.id, caseSensitive: false });
  check(found.hits.length > 0, "Full-text search did not reach the Host");
  story = await api.autonameStory(story.id);
  check(story.title === "The Quiet After Rain", "Autoname did not persist");
  check((await api.exportMarkdown(story.id)).markdown.includes(story.title), "Export omitted the title");
  const asideDeltas: string[] = [];
  const aside = await api.askAside(story.id, "Why did the door open?",
    (text) => asideDeltas.push(text), new AbortController().signal);
  check(aside?.notes.length === 1 && asideDeltas.join("").length > 0, "Aside did not stream or persist");
  await api.clearAside(story.id);
  check((await api.getAside(story.id)).notes.length === 0, "Aside was not cleared");

  const markdown = await api.importMarkdown("First part.\n\n## Later\n\nSecond part.", "Desktop import");
  check(markdown.path.length === 2 && markdown.chapterBreaks.length === 1, "Markdown import failed");
  await api.deleteStory(markdown.id);
  const silly = await api.importSillyTavern([
    JSON.stringify({ character_name: "Mira", user_name: "You" }),
    JSON.stringify({ is_user: true, mes: "Begin" }),
    JSON.stringify({ is_user: false, mes: "One" })
  ].join("\n"));
  check(silly.payload.path.length === 1, "SillyTavern import failed");
  await api.deleteStory(silly.payload.id);
  const novel = await api.importNovelAI(JSON.stringify({ storyContainerVersion: 1,
    metadata: { title: "Desktop NovelAI" }, content: { story: { fragments: [{ data: "A line." }] } } }));
  check(novel.payload.title === "Desktop NovelAI", "NovelAI import failed");
  await api.deleteStory(novel.payload.id);
  await api.deleteStory(story.id);
  await refuses(api.loadStory("missing-story"), "not_found");
};

void createRendererApi().then((api) => {
  window.contractApi = api;
  window.contractReady = true;
}).catch((error: unknown) => {
  window.contractError = error instanceof Error ? error.message : String(error);
});
