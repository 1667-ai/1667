import type { StoryApi } from "../../../client/api.js";
import type { PreviewSource } from "./preview-stream.js";
import { steeringInstruction } from "./steering.js";

type PreviewApi = Required<Pick<StoryApi, "previewContinuation">>;

/**
 * The preview source of one story line: each request continues `prefix` as
 * the text of a new part under `parentId`. The server streams the text that
 * follows `prefix` and saves nothing.
 */
export function createPreviewSource(api: PreviewApi, storyId: string, parentId: string | null): PreviewSource {
  return {
    async *complete(prefix, steering, signal) {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      let failed = false;
      let failure: unknown;
      const notify = (): void => {
        wake?.();
        wake = null;
      };
      void api.previewContinuation(
        storyId,
        { parentId, instruction: steeringInstruction(steering), prefix },
        (delta) => {
          queue.push(delta);
          notify();
        },
        signal
      ).then(
        () => undefined,
        (error: unknown) => {
          failed = true;
          failure = error;
        }
      ).then(() => {
        finished = true;
        notify();
      });
      for (;;) {
        while (queue.length > 0) yield queue.shift() as string;
        if (finished) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failed && !signal.aborted) throw failure;
    }
  };
}
