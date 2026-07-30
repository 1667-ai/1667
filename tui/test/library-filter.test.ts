import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { handleKey, initialState, type AppSource } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { pasteInto } from "../src/keys.js";
import { publishStories } from "../src/overlay-publication.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createWrapCache } from "../src/wrap.js";

const key = (name: string, sequence = name): KeyEvent => ({
  name,
  sequence,
  shift: false,
  ctrl: false,
  meta: false
}) as KeyEvent;

function harness() {
  const source: AppSource = demoAppSource();
  const state = initialState(source, false);
  const press = (name: string, sequence = name) => handleKey(
    key(name, sequence),
    state,
    source,
    createWrapCache(),
    () => {},
    async () => {},
    () => {}
  );
  return { source, state, press };
}

describe("live Library filter", () => {
  test("filters stories while the writer types", async () => {
    const { state, press } = harness();
    await press("o");
    await press("/");
    await press("w");

    expect(state.library?.prompt).toEqual({
      kind: "filter",
      initial: {
        query: "",
        cursor: 0,
        storyId: state.payload.id
      }
    });
    expect(state.library?.query).toBe("w");
    let frame = frameText(renderStoryScreen(state, { width: 120, height: 36 }).lines);
    expect(frame).toContain("the winter orchard");
    expect(frame).not.toContain("▸ the lantern keeper");

    for (const character of "inter") await press(character);
    expect(state.library?.query).toBe("winter");
    await press("return", "\r");

    expect(state.library?.prompt).toBe(null);
    expect(state.library?.query).toBe("winter");
    frame = frameText(renderStoryScreen(state, { width: 120, height: 36 }).lines);
    expect(frame).toContain("the winter orchard");
    expect(frame).not.toContain("▸ the lantern keeper");

    await press("/");
    await press("x");
    expect(state.library?.query).toBe("winterx");
    await press("escape");
    expect(state.library?.prompt).toBe(null);
    expect(state.library?.query).toBe("winter");
  });

  test("keeps a moved selection when it closes", async () => {
    const { state, press } = harness();
    await press("o");
    await press("/");
    for (const character of "the") await press(character);
    expect(state.library?.query).toBe("the");
    await press("down");
    expect(state.library?.cursor).toBe(1);

    await press("return", "\r");

    expect(state.library?.prompt).toBe(null);
    expect(state.library?.cursor).toBe(1);
  });

  test("keeps the next matching story operable after an empty result", async () => {
    const { source, state, press } = harness();
    await press("o");
    await press("/");
    for (const character of "brand new match") await press(character);
    expect(state.library?.cursor).toBe(0);

    await press("down");
    await press("return", "\r");

    expect(state.library?.prompt).toBe(null);
    expect(state.library?.cursor).toBe(0);
    const match = {
      ...source.stories[0]!,
      id: "brand-new-match",
      title: "brand new match"
    };
    publishStories(state, source, [...source.stories, match]);
    source.api.loadStory = async (id) => ({
      ...source.payload,
      id,
      title: match.title
    });

    await press("return", "\r");

    expect(state.payload.id).toBe(match.id);
  });

  test("preserves the selected matching story after paste", async () => {
    const { source, state, press } = harness();
    await press("o");
    const selected = state.library!.stories.find(
      (story) => story.title === "the winter orchard"
    )!;
    state.library!.cursor = state.library!.stories.findIndex(
      (story) => story.id === selected.id
    );
    await press("/");

    expect(pasteInto(state, "the")).toBeTrue();
    await press("return", "\r");
    source.api.loadStory = async (id) => ({
      ...source.payload,
      id,
      title: selected.title
    });
    await press("return", "\r");

    expect(state.payload.id).toBe(selected.id);
  });

  test("does not transfer selection when the selected story stops matching", async () => {
    const { state, press } = harness();
    await press("o");
    state.library!.cursor = 1;
    const selectedId = state.library!.stories[1]!.id;
    await press("/");
    for (const character of "the") await press(character);

    const visible = state.library!.stories.filter((story) =>
      story.title.includes("the")
    );
    expect(visible.some((story) => story.id === selectedId)).toBeFalse();
    expect(state.library?.cursor).toBe(0);
  });

  test("restores the selected story after a catalog reorder", async () => {
    const { source, state, press } = harness();
    await press("o");
    state.library!.cursor = 2;
    const initialId = state.library!.stories[2]!.id;
    await press("/");
    await press("w");

    publishStories(state, source, [...state.library!.stories].reverse());
    await press("escape");

    expect(state.library?.prompt).toBe(null);
    expect(state.library?.query).toBe("");
    expect(state.library?.stories[state.library.cursor]?.id).toBe(initialId);
  });

  test("stays open if a refresh removes its initial story", async () => {
    const { source, state, press } = harness();
    await press("o");
    const initialId = state.library!.stories[0]!.id;
    await press("/");
    await press("w");

    publishStories(
      state,
      source,
      state.library!.stories.filter((story) => story.id !== initialId)
    );

    expect(state.library?.prompt?.kind).toBe("filter");
    expect(state.library?.query).toBe("w");
    await press("i");
    expect(state.library?.query).toBe("wi");
  });

  test("never retargets a missing rename target", async () => {
    const { source, state, press } = harness();
    let renames = 0;
    source.api.renameStory = async () => {
      renames += 1;
      throw new Error("must not retarget");
    };
    await press("o");
    state.library!.prompt = {
      kind: "rename",
      value: "wrong target",
      targetId: "missing-story"
    };

    await press("return", "\r");

    expect(renames).toBe(0);
    expect(state.library?.prompt).toBe(null);
    expect(state.toast).toBe("story changed · action cancelled");
  });
});
