import type { PromptTokenCount } from "../../../shared/tokenize-source.js";
import { initialState } from "../../src/app.js";
import { demoAppSource } from "../../src/demo.js";
import type { StreamView } from "../../src/state.js";

type TimerHandle = ReturnType<typeof setTimeout>;

/** A scheduler that gives prompt-count tests exact control of each delay. */
export function promptTokenCountClock() {
  let nextHandle = 1;
  const tasks = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    schedule(callback: () => void, delayMs: number): TimerHandle {
      const handle = nextHandle++;
      tasks.set(handle, { callback, delayMs });
      return handle as unknown as TimerHandle;
    },
    cancel(handle: TimerHandle) {
      tasks.delete(handle as unknown as number);
    },
    pendingCount() {
      return tasks.size;
    },
    fireAll() {
      const callbacks = [...tasks.values()].map((task) => task.callback);
      tasks.clear();
      for (const callback of callbacks) callback();
    },
    fireDelay(delayMs: number) {
      const due = [...tasks.entries()].filter(([, task]) => task.delayMs === delayMs);
      for (const [handle, task] of due) {
        tasks.delete(handle);
        task.callback();
      }
    }
  };
}

export async function flushPromptTokenCount(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

export function countedPromptTokenAnswer(total: number): PromptTokenCount {
  return { kind: "counted", source: "bundled-openai", grade: "exact", total, perMessage: null };
}

export function promptTokenCountStream(text: string): StreamView {
  return {
    targetId: "stream-target",
    parentId: null,
    append: false,
    startedAt: "2026-08-08T00:00:00.000Z",
    instruction: "",
    text
  };
}

export function promptTokenCountFixture() {
  const source = demoAppSource();
  const state = initialState(source, false);
  const clock = promptTokenCountClock();
  let repaints = 0;
  const repaint = () => { repaints += 1; };
  return { state, source, clock, repaint, repaints: () => repaints };
}
