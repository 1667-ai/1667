import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { useBarClearance } from "../ui/bar-clearance.js";
import { manuscriptGenerationView, type GenerationState } from "./state.js";

/**
 * The buttons that go with the generation state (#409 steps 5 and 6):
 * Continue while idle, Stop while it writes, a disabled "Saving…" while the
 * stopped text is committed, and Copy / Retry / Discard for unsaved text.
 * They know nothing of the composer; `onContinue` is the caller's send (the
 * story's composer sends its box, so an empty box is a plain Continue).
 *
 * Look ported from StoryTavern's `ComposerFooter` (`btn-primary btn-cta`,
 * `btn-danger btn-cta`) — see `styles/generation.css`.
 */
export function GenerationButtons({ onContinue }: { readonly onContinue: () => void }) {
  const { store, actions } = useAppContext();
  const kind = useStore(store, (state) => state.generation.kind);

  if (kind === "idle") {
    return (
      <button
        type="button"
        className="btn btn-primary btn-cta"
        aria-keyshortcuts="Space"
        title="Continue (Space)"
        onClick={onContinue}
      >
        Continue
      </button>
    );
  }
  if (kind === "unsaved") {
    return (
      <>
        <button
          type="button"
          className="btn"
          title="Copy text"
          onClick={() => { void actions.generation.copyUnsaved(); }}
        >
          Copy
        </button>
        <button
          type="button"
          className="btn"
          title="Save again"
          onClick={() => { void actions.generation.retrySave(); }}
        >
          Retry
        </button>
        <button
          type="button"
          className="btn btn-danger"
          title="Discard"
          onClick={actions.generation.discardUnsaved}
        >
          Discard
        </button>
      </>
    );
  }
  if (kind === "settling") {
    return <button type="button" className="btn btn-primary btn-cta" title="Saving" disabled>Saving…</button>;
  }
  return (
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

/** The story mount's status text: `null` while idle. The "in this story" case
 * reuses `manuscriptGenerationView`'s own `statusLabel` verbatim (review fix
 * #10) — the exact same Waiting/Thinking/Writing/Not-saved text `StoryView`'s
 * live region shows — so the bar and the manuscript can never disagree. The
 * "a different story" case has no matching `storyId` to view, so it repeats
 * only the one boundary that still applies there: "Waiting…" until either
 * reasoning or text exists (review fix #12). */
export function generationStatusText(generation: GenerationState, viewingStoryId: string | null): string | null {
  if (generation.kind === "idle") return null;
  if (generation.storyId !== viewingStoryId) {
    if (generation.kind === "unsaved") return `Not saved in ${generation.storyTitle}`;
    return generation.reasoning === null && generation.text.length === 0
      ? `Waiting to write in ${generation.storyTitle}…`
      : `Writing in ${generation.storyTitle}…`;
  }
  return manuscriptGenerationView(generation, generation.storyId)?.statusLabel ?? "";
}

/**
 * The Library's bar (`App.tsx`'s `Shell`): shown only while a generation
 * exists somewhere, so "one web generation at a time" always has a visible
 * Stop from wherever the reader is (owner decision 2). It has no composer and
 * no Continue — there is no focused part to continue from on that route.
 */
export function GenerationBar() {
  const { store } = useAppContext();
  const generation = useStore(store, (state) => state.generation);
  const barRef = useBarClearance();
  if (generation.kind === "idle") return null;
  return (
    <div ref={barRef} className={`generation-bar${generation.kind === "unsaved" ? " generation-bar-unsaved" : ""}`}>
      <span className="generation-status">{generationStatusText(generation, null)}</span>
      <div className="generation-bar-actions">
        <GenerationButtons onContinue={() => {}} />
      </div>
    </div>
  );
}
