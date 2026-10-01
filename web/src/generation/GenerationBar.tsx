import type { ReactNode } from "react";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Composer, useSendFromButton } from "../compose/Composer.js";
import { manuscriptGenerationView, type GenerationState } from "./state.js";

/**
 * The bottom bar (#409 steps 5 and 6) — mounted twice: at the bottom of the
 * open story's own main area (`StoryView.tsx`), and at the library route
 * (`App.tsx`'s `Shell`, only while a generation is running somewhere) so
 * "one web generation at a time" always has a visible Stop from wherever the
 * reader is (owner decision 2). `viewingStoryId` is the story this particular
 * mount belongs to — `null` for the library mount, which has no focused part
 * and so no composer and no Continue.
 *
 * In a story the bar holds the composer, with the Continue / Stop button (or
 * Copy / Retry / Discard for unsaved text) beside it. Look ported from
 * StoryTavern's `ComposerFooter` (`btn-primary btn-cta`, `btn-danger
 * btn-cta`) — see `styles/generation.css`, `styles/compose.css`.
 */
export function GenerationBar({ viewingStoryId }: { readonly viewingStoryId: string | null }) {
  const { store, actions } = useAppContext();
  const generation = useStore(store, (state) => state.generation);
  const send = useSendFromButton(viewingStoryId ?? "");

  const inThisStory = generation.kind !== "idle" && generation.storyId === viewingStoryId;
  const status = generation.kind === "idle" ? null : statusText(generation, inThisStory);

  let buttons: ReactNode;
  if (generation.kind === "idle") {
    buttons = (
      <button
        type="button"
        className="btn btn-primary btn-cta"
        aria-keyshortcuts="Space"
        title="Continue (Enter in the box, Space elsewhere)"
        onClick={send}
      >
        Continue
      </button>
    );
  } else if (generation.kind === "unsaved") {
    buttons = (
      <>
        <button
          type="button"
          className="btn"
          title="Copy the unsaved text"
          onClick={() => { void actions.generation.copyUnsaved(); }}
        >
          Copy
        </button>
        <button
          type="button"
          className="btn"
          title="Try to save the text again"
          onClick={() => { void actions.generation.retrySave(); }}
        >
          Retry
        </button>
        <button
          type="button"
          className="btn btn-danger"
          title="Throw the unsaved text away"
          onClick={actions.generation.discardUnsaved}
        >
          Discard
        </button>
      </>
    );
  } else if (generation.kind === "settling") {
    buttons = <button type="button" className="btn btn-primary btn-cta" disabled>Saving…</button>;
  } else {
    buttons = (
      <button
        type="button"
        className="btn btn-danger btn-cta"
        aria-keyshortcuts="Escape"
        title="Stop (Esc)"
        onClick={actions.generation.stop}
      >
        Stop
      </button>
    );
  }

  const barClass = `generation-bar${generation.kind === "unsaved" ? " generation-bar-unsaved" : ""}`;

  if (viewingStoryId !== null) {
    return (
      <div className={`${barClass} generation-bar-compose`}>
        <Composer storyId={viewingStoryId} status={status}>{buttons}</Composer>
      </div>
    );
  }
  if (generation.kind === "idle") return null;
  return (
    <div className={barClass}>
      <span className="generation-status">{status}</span>
      <div className="generation-bar-actions">{buttons}</div>
    </div>
  );
}

/** The "in this story" case reuses `manuscriptGenerationView`'s own
 * `statusLabel` verbatim (review fix #10) — the exact same
 * Waiting/Thinking/Writing/Not-saved text `StoryView`'s live region shows —
 * so this bar and the manuscript read view can never disagree. The "a
 * different story" case cannot call that (it has no matching `storyId` to
 * view), so it repeats only the one boundary that still applies there:
 * "Waiting…" until either reasoning or text exists (review fix #12). */
function statusText(generation: Exclude<GenerationState, { kind: "idle" }>, inThisStory: boolean): string {
  if (!inThisStory) {
    if (generation.kind === "unsaved") return `Not saved in ${generation.storyTitle}`;
    return generation.reasoning === null && generation.text.length === 0
      ? `Waiting to write in ${generation.storyTitle}…`
      : `Writing in ${generation.storyTitle}…`;
  }
  return manuscriptGenerationView(generation, generation.storyId)?.statusLabel ?? "";
}
