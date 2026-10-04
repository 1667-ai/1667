import { apiErrorCode } from "../../../client/api-error.js";
import { textHash } from "../../../client/api.js";
import { activeLineFingerprintSource } from "../../../shared/story-text.js";
import { createRafFlushScheduler } from "../generation/stream-buffer.js";
import { chapterWord } from "../../../shared/chapter-labels.js";
import type { StoryChapter } from "../../../shared/manuscript-model.js";
import { manuscriptModelOf } from "../story/manuscript-model.js";
import type { StoryPayload } from "../../../shared/types.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import { STORY_RELOADED_TOAST, type StoryActions } from "../story/actions.js";
import { runBusyToast } from "../app/run-lock.js";
import { SWITCHING_TOAST, summarizeRefusal } from "../story/story-policy.js";
import { chapterClosedBy, openStory } from "./model.js";
import type { ChaptersState, SummaryRun } from "./state.js";

/**
 * One chapter summary run. It behaves like a generation — status and Stop in
 * the bottom bar, Esc stops it, the story is locked while it runs, and the
 * story is reloaded after a stop or a failure — but the text appears when the
 * run is done: `summarizeChapter` is unary today. Streaming can slot in
 * later, between `start` and `finish`.
 */

export interface SummaryActions {
  /** Summarizes the chapter with this number (a refresh when it already has a
   * summary). A refusal is a toast and nothing else. */
  summarize(chapterNumber: number): Promise<void>;
  /** The palette's "summary take": summarizes the whole line into a summary
   * part at its end, streaming the text. A refusal is a toast. */
  summarizeLine(): Promise<void>;
  /** Esc and Stop. Returns whether there was a run to stop. */
  stopSummary(): boolean;
}

/** The summary of the chapter `breakId` closes: its id and the time it was
 * made, to tell a new one from the one that stood in before. */
function summaryStamp(payload: StoryPayload | null, breakId: string): string | null {
  const chapter = payload === null ? null : chapterClosedBy(payload, breakId);
  return chapter?.summary == null ? null : `${chapter.summary.id}@${chapter.summary.madeAt ?? ""}`;
}

export function createSummaryActions(
  store: Store<AppState>,
  deps: { readonly story: Pick<StoryActions, "adoptPayload"> }
): SummaryActions {
  let controller: AbortController | null = null;

  const write = (update: (chapters: ChaptersState) => ChaptersState): void =>
    store.set((state) => {
      const chapters = update(state.chapters);
      return chapters === state.chapters ? state : { ...state, chapters };
    });

  const finish = (): void => {
    controller = null;
    write((chapters) => (chapters.summaryRun === null ? chapters : { ...chapters, summaryRun: null }));
  };

  async function run(
    open: NonNullable<ReturnType<typeof openStory>>,
    chapter: StoryChapter,
    breakId: string
  ): Promise<void> {
    const { storyId, api } = open;
    const word = chapterWord(chapter.number);
    const before = summaryStamp(open.payload, breakId);
    const mine = new AbortController();
    controller = mine;
    const started: SummaryRun = {
      storyId,
      storyTitle: open.payload.title,
      breakId,
      chapterNumber: chapter.number,
      refresh: chapter.summary !== null,
      phase: "running",
      text: ""
    };
    write((chapters) => ({ ...chapters, summaryRun: started }));

    /** Tells the writer how it ended, in the story or — when the reader has
     * left it — by name. */
    const say = (applied: boolean, message: string): void => {
      pushToast(store, applied ? message : `${message.replace(/\.$/, "")} in ${started.storyTitle}.`);
    };

    try {
      // A retry after the writer pressed Stop would start the run again.
      const payload = await retryWhenBusy(() => {
        mine.signal.throwIfAborted();
        return api.summarizeChapter(storyId, breakId, mine.signal);
      });
      const message = mine.signal.aborted
        ? `Chapter ${word} summary completed before stop.`
        : started.refresh ? `Chapter ${word} summary refreshed.` : `Chapter ${word} summarized.`;
      say(deps.story.adoptPayload(storyId, payload, { announcement: message }), message);
    } catch (error) {
      // Always reload: a run that failed or was stopped can still have
      // changed the story, and the held version would then be refused.
      const reloaded = await api.loadStory(storyId).catch(() => null);
      const applied = reloaded === null ? false : deps.story.adoptPayload(storyId, reloaded);
      if (mine.signal.aborted) {
        const after = summaryStamp(reloaded, breakId);
        const landed = after !== null && after !== before;
        say(applied, landed ? `Chapter ${word} summary completed before stop.` : `Chapter ${word} summary stopped.`);
      } else if (apiErrorCode(error) === "conflict" || apiErrorCode(error) === "revision_conflict") {
        pushToast(store, STORY_RELOADED_TOAST);
      } else {
        pushToast(store, errorMessage(error));
      }
    } finally {
      if (controller === mine) finish();
    }
  }

  /** One summary take of the line, as the TUI's `startSummary`: the server
   * writes the take, then the line is switched to stop at it. Stop drops the
   * draft whole. */
  async function runLine(open: NonNullable<ReturnType<typeof openStory>>): Promise<void> {
    const { storyId, api, payload } = open;
    const leaf = payload.path.at(-1);
    if (leaf === undefined) return;
    const mine = new AbortController();
    controller = mine;
    const started: SummaryRun = {
      storyId, storyTitle: payload.title, breakId: null, chapterNumber: null, refresh: false, phase: "running", text: ""
    };
    write((chapters) => ({ ...chapters, summaryRun: started }));
    let text = "";
    const scheduler = createRafFlushScheduler();
    const say = (applied: boolean, message: string): void => {
      pushToast(store, applied ? message : `${message.replace(/\.$/, "")} in ${started.storyTitle}.`);
    };
    try {
      const fingerprint = textHash(activeLineFingerprintSource(payload.title, payload.path));
      const result = await retryWhenBusy(() => {
        mine.signal.throwIfAborted();
        return api.createSummaryTake(storyId, { nodeId: leaf.id }, (delta) => {
          text += delta;
          scheduler.schedule(() => write((chapters) => (
            chapters.summaryRun === null ? chapters : { ...chapters, summaryRun: { ...chapters.summaryRun, text } }
          )));
        }, mine.signal, { onPayload: () => false });
      });
      if (result === null || mine.signal.aborted) throw new DOMException("stopped", "AbortError");
      const switched = await api.switchLine(storyId, result.nodeId, {
        stopAtNode: true,
        expectedLineFingerprint: await fingerprint
      });
      const message = result.narrowedTo === null
        ? "Summary take saved."
        : "Summary take saved. It covers less of the story than requested.";
      say(deps.story.adoptPayload(storyId, switched, { announcement: message }), message);
    } catch (error) {
      const reloaded = await api.loadStory(storyId).catch(() => null);
      const applied = reloaded === null ? false : deps.story.adoptPayload(storyId, reloaded);
      if (mine.signal.aborted) say(applied, "Summary stopped. The draft was dropped.");
      else if (apiErrorCode(error) === "conflict" || apiErrorCode(error) === "revision_conflict") {
        pushToast(store, STORY_RELOADED_TOAST);
      } else pushToast(store, errorMessage(error));
    } finally {
      scheduler.cancel();
      if (controller === mine) finish();
    }
  }

  return {
    summarizeLine: async () => {
      const state = store.get();
      const open = openStory(state);
      if (open === null) return;
      if (open.payload.path.length === 0) {
        pushToast(store, "Nothing to summarize.");
        return;
      }
      const busy = runBusyToast(state, open.storyId);
      if (busy !== null) {
        pushToast(store, busy);
        return;
      }
      if (state.story.kind === "loaded" && state.story.switching !== null) {
        pushToast(store, SWITCHING_TOAST);
        return;
      }
      await runLine(open);
    },

    summarize: async (chapterNumber) => {
      const state = store.get();
      const open = openStory(state);
      if (open === null) return;
      const chapter = manuscriptModelOf(open.payload).chapters.find((candidate) => candidate.number === chapterNumber);
      if (chapter === undefined) return;
      const refusal = summarizeRefusal(state, open.storyId, { closed: chapter.closedBy !== null });
      if (refusal !== null) {
        pushToast(store, refusal);
        return;
      }
      await run(open, chapter, chapter.closedBy!.id);
    },

    stopSummary: () => {
      const current = store.get().chapters.summaryRun;
      if (current === null || current.phase !== "running" || controller === null) return false;
      write((chapters) => ({ ...chapters, summaryRun: { ...current, phase: "stopping" } }));
      controller.abort();
      return true;
    }
  };
}
