import { describe, expect, test } from "bun:test";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState } from "../src/app.js";
import { setComposerText } from "../src/composer-model.js";
import { demoAppSource } from "../src/demo.js";
import { openFactEditor } from "../src/editor-action.js";
import { recordSessionNotices } from "../src/notice-log.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import type { FactEditorSession, RuntimeState } from "../src/state.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { MAX_FACT_TEXT_CHARS } from "../../shared/types.js";
import { editorHarness, key } from "./editor-harness.js";

/** Ctrl+S's raw terminal sequence (0x13), built at runtime so the literal
 *  control byte never has to live in this file's source text — matches
 *  fact-editor.test.ts's own convention. */
const SAVE_SEQUENCE = String.fromCharCode(0x13);
const SAVE = key("s", { sequence: SAVE_SEQUENCE, ctrl: true });

function activeFactEditor(state: RuntimeState): FactEditorSession {
  const editor = state.editor;
  if (editor?.kind !== "fact") throw new Error("expected an active Fact editor");
  return editor;
}

function frame(state: RuntimeState, width = 100, height = 30): string {
  return frameText(renderStoryScreen(state, { width, height }).lines);
}

describe("Fact text limit — synchronous rejection (issue: a fact over the limit silently failed to save)", () => {
  test("an over-limit Fact never reaches the network, and the editor names the limit and what to do", async () => {
    const { source, state, press } = editorHarness();
    let createCalls = 0;
    const createFact = source.api.createFact;
    source.api.createFact = async (...args) => {
      createCalls += 1;
      return createFact(...args);
    };

    await press(key("f"));
    await press(key("n"));
    setComposerText(activeFactEditor(state).composer, "x".repeat(MAX_FACT_TEXT_CHARS + 1));

    await press(SAVE);

    expect(createCalls).toBe(0);
    expect(state.mode).toBe("EDITOR");
    expect(state.toast).toContain(`${MAX_FACT_TEXT_CHARS.toLocaleString()}-character limit`);
    expect(state.toast).toContain("shorten it before saving");
  });

  test("a Fact exactly at the limit is not refused", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("n"));
    setComposerText(activeFactEditor(state).composer, "x".repeat(MAX_FACT_TEXT_CHARS));

    await press(SAVE);

    expect(state.mode).toBe("FACTS");
    expect(state.payload.facts.some((fact) => fact.text.length === MAX_FACT_TEXT_CHARS)).toBeTrue();
  });
});

describe("Fact text limit — the size counter (item 3: warn before the writer hits the wall)", () => {
  test("stays quiet for an ordinary Fact", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("n"));
    setComposerText(activeFactEditor(state).composer, "A short fact about the lighthouse keeper.");

    expect(frame(state)).not.toContain(`/ ${MAX_FACT_TEXT_CHARS.toLocaleString()} chars`);
  });

  test("appears once a Fact nears the limit, and reports the exact count", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("n"));
    const nearLimit = MAX_FACT_TEXT_CHARS - 1;
    setComposerText(activeFactEditor(state).composer, "x".repeat(nearLimit));

    expect(frame(state)).toContain(`${nearLimit.toLocaleString()} / ${MAX_FACT_TEXT_CHARS.toLocaleString()} chars`);
  });
});

describe("Fact text limit — a lost async error is recoverable (item 4: the notice log makes every transient channel honest)", () => {
  test("an async save failure lands in the notice log immediately, and outlives the next keystroke's toast", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    // The production repaint (app.ts) records every notice as it repaints —
    // "a backend task can raise a notice long after the key that started it,
    // so the log is filled here as well as at the end of dispatch." Rebuilding
    // that one line is what makes this a fair test of the real wiring instead
    // of a stub that begs the question.
    const repaint = () => recordSessionNotices(state);
    const backend = new ActionRuntime(state, repaint);
    const dispatchKey = (event: Parameters<typeof handleKey>[0]) => {
      const work = handleKey(
        event, state, source, cache, repaint,
        async () => undefined, () => undefined,
        {
          updateChecks: INERT_UPDATE_CHECK_LIFECYCLE,
          renderer: null,
          applyTheme: () => undefined,
          previewTheme: () => undefined,
          backend
        }
      );
      // The real dispatcher hands the whole key's promise to
      // `backend.observe()` (see presented-input-queue.ts
      // `observeInputAdmission`); this reproduces exactly that handoff.
      backend.observe(work);
      return work.catch(() => undefined);
    };

    const fact = state.payload.facts[0]!;
    openFactEditor(state, fact);
    const editor = activeFactEditor(state);
    setComposerText(editor.composer, `${editor.composer.text} — a real, in-limit edit`);
    source.api.patchFact = async () => { throw new Error("mock backend outage"); };

    await dispatchKey(SAVE);

    expect(state.toast).toBe("mock backend outage");
    expect(state.notices.entries.some((entry) => entry.text === "mock backend outage")).toBeTrue();

    // The next keystroke's dispatch wipes the live toast (app.ts's dispatch
    // clears it unconditionally at the top of every call) — that is the half
    // of the race this fix does not touch. The log must still remember it.
    await dispatchKey(key("down"));

    expect(state.toast).not.toBe("mock backend outage");
    expect(state.notices.entries.some((entry) => entry.text === "mock backend outage")).toBeTrue();
  });
});
