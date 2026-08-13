import { expect, test } from "bun:test";
import { ASIDE_EXPORT_OMISSION_NOTICE } from "../../shared/aside.js";
import { createDemoController, demoStoryApi } from "../src/demo.js";

test("demo Side Notes persist, append, clear, and report Markdown omission", async () => {
  const demo = createDemoController();
  const api = demoStoryApi(demo);
  const storyId = demo.payload().id;

  const first = await api.askAside(storyId, "First?", () => undefined, new AbortController().signal);
  expect(first?.notes).toEqual([{
    question: "First?",
    answer: "Demo Aside answer for: First?"
  }]);
  expect(first?.payload?.hasAside).toBeTrue();
  expect((await api.getAside(storyId)).notes).toEqual(first?.notes);
  expect((await api.loadStory(storyId)).hasAside).toBeTrue();
  expect((await api.exportMarkdown(storyId)).fidelity).toEqual([
    ASIDE_EXPORT_OMISSION_NOTICE
  ]);

  const second = await api.askAside(storyId, "Second?", () => undefined, new AbortController().signal);
  expect(second?.notes.map((note) => note.question)).toEqual(["First?", "Second?"]);

  const cleared = await api.clearAside(storyId);
  expect(cleared.hasAside).toBe(undefined);
  expect((await api.getAside(storyId)).notes).toEqual([]);
  expect((await api.exportMarkdown(storyId)).fidelity).toEqual([]);
});
