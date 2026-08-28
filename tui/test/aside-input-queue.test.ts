import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { asideNotes, createAsideSurface } from "../src/aside-surface.js";
import { demoAppSource } from "../src/demo.js";
import { ActionRuntime, beginInteraction, withActionAdmission } from "../src/action-runtime.js";
import { handleKey, initialState } from "../src/app.js";
import {
  createPresentedInputQueue,
  observeInputAdmission
} from "../src/presented-input-queue.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { setComposerText } from "../src/composer-model.js";
import { pasteInto } from "../src/keys.js";

function key(name: string): KeyEvent {
  return { name, sequence: name, shift: false, ctrl: false, meta: false } as KeyEvent;
}

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe("Aside presented input", () => {
  test("queued Esc keeps an Aside answer that already streamed", async () => {
    const source = demoAppSource();
    let release!: () => void;
    let signal: AbortSignal | null = null;
    let emitDelta: ((text: string) => void) | null = null;
    const aborted: boolean[] = [];
    const gate = new Promise<void>((resolve) => { release = resolve; });
    source.api = {
      ...source.api,
      askAside: async (_storyId, _question, onDelta, requestSignal) => {
        signal = requestSignal;
        emitDelta = onDelta;
        requestSignal.addEventListener("abort", () => { aborted.push(true); }, { once: true });
        await gate;
        return requestSignal.aborted
          ? { notes: [{ question: "Why did it change?", answer: "partial answer" }] }
          : { notes: [] };
      }
    };
    const state = initialState(source, false);
    state.mode = "ASIDE";
    state.aside = createAsideSurface(state.payload.id, state.payload.title);
    setComposerText(state.aside.composer, "Why did it change?");
    const repaintEvents: string[] = [];
    const repaint = () => {
      repaintEvents.push(`${state.aside?.busy ? "busy" : "idle"}:${state.aside?.streamText ?? ""}`);
    };
    const backend = new ActionRuntime(state, repaint);
    const queue = createPresentedInputQueue({ flush() {}, ready: () => true });
    const cache = createWrapCache<ProseStyle>();
    const enqueue = (event: KeyEvent) => {
      queue.enqueue(() => observeInputAdmission((admit) => handleKey(
        event,
        state,
        source,
        cache,
        () => { repaint(); admit(); },
        () => { admit(); return Promise.resolve(); },
        () => undefined,
        null,
        () => undefined,
        () => undefined,
        withActionAdmission(backend, admit)
      ), (work) => backend.observe(work)));
    };

    enqueue(key("return"));
    expect(state.aside.busy).toBeTrue();
    expect(state.backendTask?.label).toBe("asking Aside");
    expect(signal).not.toBeNull();
    expect(repaintEvents.length).toBeGreaterThan(1);

    emitDelta!("partial answer");
    expect(state.aside.streamText).toBe("partial answer");
    expect(repaintEvents.at(-1)).toBe("busy:partial answer");

    enqueue(key("escape"));
    await drainMicrotasks();
    expect(signal!.aborted).toBeTrue();
    expect(aborted).toHaveLength(1);

    release();
    await backend.whenIdle();
    await drainMicrotasks();
    expect(state.aside.busy).toBeFalse();
    expect(state.aside.streamText).toBe("");
    expect(state.aside.composer.text).toBe("");
    expect(asideNotes(state.aside!)).toEqual([{
      question: "Why did it change?",
      answer: "partial answer"
    }]);
    expect(state.toast).toBe("Aside stopped · answer kept");
    expect(state.abort).toBeNull();
    backend.dispose();
  });

  test("typed input before Esc stays newer than the stopped ask", async () => {
    const source = demoAppSource();
    let release!: () => void;
    let signal: AbortSignal | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    source.api = {
      ...source.api,
      askAside: async (_storyId, _question, _onDelta, requestSignal) => {
        signal = requestSignal;
        await gate;
        return requestSignal.aborted ? null : { notes: [] };
      }
    };
    const state = initialState(source, false);
    state.mode = "ASIDE";
    state.aside = createAsideSurface(state.payload.id, state.payload.title);
    setComposerText(state.aside.composer, "Submitted question");
    const backend = new ActionRuntime(state, () => undefined);
    const queue = createPresentedInputQueue({ flush() {}, ready: () => true });
    const cache = createWrapCache<ProseStyle>();
    const enqueue = (event: KeyEvent) => {
      queue.enqueue(() => observeInputAdmission((admit) => handleKey(
        event,
        state,
        source,
        cache,
        admit,
        () => { admit(); return Promise.resolve(); },
        () => undefined,
        null,
        () => undefined,
        () => undefined,
        withActionAdmission(backend, admit)
      ), (work) => backend.observe(work)));
    };

    enqueue(key("return"));
    expect(state.aside.busy).toBeTrue();
    enqueue(key("d"));
    await drainMicrotasks();
    expect(state.aside.composer.text).toBe("d");

    enqueue(key("escape"));
    await drainMicrotasks();
    expect(signal!.aborted).toBeTrue();

    release();
    await backend.whenIdle();
    await drainMicrotasks();
    expect(state.aside.busy).toBeFalse();
    expect(state.aside.composer.text).toBe("d");
    expect(state.aside.inflightQuestion).toBeNull();
    backend.dispose();
  });

  test("settles a failed ask after scroll and paste without overwriting the newer draft", async () => {
    const source = demoAppSource();
    let rejectAsk!: (error: Error) => void;
    const gate = new Promise<never>((_, reject) => { rejectAsk = reject; });
    source.api = {
      ...source.api,
      askAside: async () => {
        await gate;
        return null;
      }
    };
    const state = initialState(source, false);
    state.mode = "ASIDE";
    state.aside = createAsideSurface(
      state.payload.id,
      state.payload.title,
      Array.from({ length: 8 }, (_, index) => ({
        question: `Old question ${index}`,
        answer: `Old answer ${index}`
      }))
    );
    setComposerText(state.aside.composer, "Submitted question");
    const repaint = () => undefined;
    const backend = new ActionRuntime(state, repaint);
    const queue = createPresentedInputQueue({ flush() {}, ready: () => true });
    const cache = createWrapCache<ProseStyle>();
    const enqueue = (event: KeyEvent) => {
      queue.enqueue(() => observeInputAdmission((admit) => handleKey(
        event,
        state,
        source,
        cache,
        admit,
        () => { admit(); return Promise.resolve(); },
        () => undefined,
        null,
        () => undefined,
        () => undefined,
        withActionAdmission(backend, admit)
      ), (work) => backend.observe(work)));
    };
    const enqueuePaste = (text: string) => {
      queue.enqueue(() => {
        if (pasteInto(state, text)) {
          beginInteraction(state);
          repaint();
        }
      });
    };

    enqueue(key("return"));
    expect(state.aside.busy).toBeTrue();
    enqueue(key("pageup"));
    enqueuePaste("newer draft");
    await drainMicrotasks();
    expect(state.aside.scrollTop).not.toBeNull();
    rejectAsk(new Error("provider failed"));
    await backend.whenIdle();
    await drainMicrotasks();

    expect(state.aside.busy).toBeFalse();
    expect(state.aside.streamText).toBe("");
    expect(state.aside.inflightQuestion).toBeNull();
    expect(state.aside.composer.text).toBe("newer draft");
    expect(state.abort).toBeNull();
    expect(state.toast).toBe("provider failed");
    backend.dispose();
  });

  test("keeps typed edits made during a failed ask", async () => {
    const source = demoAppSource();
    let rejectAsk!: (error: Error) => void;
    const gate = new Promise<never>((_, reject) => { rejectAsk = reject; });
    source.api = {
      ...source.api,
      askAside: async () => {
        await gate;
        return null;
      }
    };
    const state = initialState(source, false);
    state.mode = "ASIDE";
    state.aside = createAsideSurface(state.payload.id, state.payload.title);
    setComposerText(state.aside.composer, "Submitted question");
    const backend = new ActionRuntime(state, () => undefined);
    const cache = createWrapCache<ProseStyle>();
    const enqueue = (event: KeyEvent) => {
      void observeInputAdmission((admit) => handleKey(
        event,
        state,
        source,
        cache,
        admit,
        () => { admit(); return Promise.resolve(); },
        () => undefined,
        null,
        () => undefined,
        () => undefined,
        withActionAdmission(backend, admit)
      ), (work) => backend.observe(work));
    };

    enqueue(key("return"));
    await drainMicrotasks();
    expect(state.aside.busy).toBeTrue();
    enqueue(key("d"));
    enqueue(key("r"));
    await drainMicrotasks();
    expect(state.aside.composer.text).toBe("dr");

    rejectAsk(new Error("provider failed"));
    await backend.whenIdle();
    await drainMicrotasks();
    expect(state.aside.busy).toBeFalse();
    expect(state.aside.composer.text).toBe("dr");
    backend.dispose();
  });

  test("keeps typed edits made during a cancelled ask", async () => {
    const source = demoAppSource();
    let resolveAsk!: () => void;
    const gate = new Promise<void>((resolve) => { resolveAsk = resolve; });
    source.api = {
      ...source.api,
      askAside: async () => {
        await gate;
        return null;
      }
    };
    const state = initialState(source, false);
    state.mode = "ASIDE";
    state.aside = createAsideSurface(state.payload.id, state.payload.title);
    setComposerText(state.aside.composer, "Submitted question");
    const backend = new ActionRuntime(state, () => undefined);
    const cache = createWrapCache<ProseStyle>();
    const enqueue = (event: KeyEvent) => {
      void observeInputAdmission((admit) => handleKey(
        event,
        state,
        source,
        cache,
        admit,
        () => { admit(); return Promise.resolve(); },
        () => undefined,
        null,
        () => undefined,
        () => undefined,
        withActionAdmission(backend, admit)
      ), (work) => backend.observe(work));
    };

    enqueue(key("return"));
    await drainMicrotasks();
    expect(state.aside.busy).toBeTrue();
    enqueue(key("d"));
    enqueue(key("r"));
    await drainMicrotasks();
    expect(state.aside.composer.text).toBe("dr");

    resolveAsk();
    await backend.whenIdle();
    await drainMicrotasks();
    expect(state.aside.busy).toBeFalse();
    expect(state.aside.composer.text).toBe("dr");
    backend.dispose();
  });

  test("settles a cancelled ask after later input without restoring the old question", async () => {
    const source = demoAppSource();
    let resolveAsk!: () => void;
    const gate = new Promise<void>((resolve) => { resolveAsk = resolve; });
    source.api = {
      ...source.api,
      askAside: async () => {
        await gate;
        return null;
      }
    };
    const state = initialState(source, false);
    state.mode = "ASIDE";
    state.aside = createAsideSurface(
      state.payload.id,
      state.payload.title,
      Array.from({ length: 8 }, (_, index) => ({
        question: `Old question ${index}`,
        answer: `Old answer ${index}`
      }))
    );
    setComposerText(state.aside.composer, "Submitted question");
    const backend = new ActionRuntime(state, () => undefined);
    const queue = createPresentedInputQueue({ flush() {}, ready: () => true });
    const cache = createWrapCache<ProseStyle>();
    const enqueue = (event: KeyEvent) => {
      queue.enqueue(() => observeInputAdmission((admit) => handleKey(
        event,
        state,
        source,
        cache,
        admit,
        () => { admit(); return Promise.resolve(); },
        () => undefined,
        null,
        () => undefined,
        () => undefined,
        withActionAdmission(backend, admit)
      ), (work) => backend.observe(work)));
    };

    enqueue(key("return"));
    enqueue(key("pageup"));
    queue.enqueue(() => {
      if (pasteInto(state, "newer draft")) beginInteraction(state);
    });
    await drainMicrotasks();
    expect(state.aside.scrollTop).not.toBeNull();
    resolveAsk();
    await backend.whenIdle();
    await drainMicrotasks();

    expect(state.aside.busy).toBeFalse();
    expect(state.aside.streamText).toBe("");
    expect(state.aside.inflightQuestion).toBeNull();
    expect(state.aside.composer.text).toBe("newer draft");
    expect(state.abort).toBeNull();
    expect(state.toast).toBeNull();
    backend.dispose();
  });
});
