import { Suspense, lazy, useEffect, useRef, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { imageInputEntryPointsOpen } from "../../../shared/image-input-release.js";
import { imageInputRefusalMessage } from "../../../shared/image-input-runtime.js";
// The thumbnails load with the first attached image.
const ImageChips = lazy(async () => ({ default: (await import("../images/ImageChips.js")).ImageChips }));
import { Icon, ICONS } from "../ui/icons.js";
import { useRequestSignal } from "../ui/useRequestSignal.js";
import { useAppContext } from "../app/context.js";
import { ContextMeter } from "../context/ContextMeter.js";
import { resolveComposeBinding } from "../app/keymap-dom.js";
import { openStoryPage } from "../app/router.js";
import { useStore } from "../app/store.js";
import { focusCurrentPart } from "../story/focus-dom.js";
import { effectiveFocusedPartId } from "../story/state.js";
import { continuationTargetLabel } from "./target.js";
import { composeDraftOf, isBrowsingHistory, visibleComposeText } from "./state.js";

/** The start of a rewritten passage, for the head of the composer. */
function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

/**
 * The Direct composer (#409 step 6), the TUI's `i` box: a one-line textarea
 * that grows with its text, above the Continue / Stop button. Enter sends,
 * Shift+Enter adds a line. In retake mode it holds the direction of a new
 * take of one part, under a "Retake part N — new direction" head.
 *
 * The box stays editable while a story writes: only a send is refused, with
 * the draft kept. `children` is the action row `GenerationBar` owns.
 */
export function Composer(
  { storyId, status, children }: {
    readonly storyId: string;
    /** This story's status text ("Writing…"), shown in the head. */
    readonly status: string | null;
    readonly children: ReactNode;
  }
) {
  const { store, actions } = useAppContext();
  const draft = useStore(store, (state) => composeDraftOf(state.compose, storyId));
  const story = useStore(store, (state) => (state.story.kind === "loaded" && state.story.payload.id === storyId ? state.story : null));
  const browsing = isBrowsingHistory(draft);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageInput = useStore(store, (state) => state.compose.imageInput);
  const attachSerial = useStore(store, (state) => state.compose.attachSerial);
  // Whether the route takes an image comes from the settings: asked when the
  // composer opens, so coming back from the settings page sees a new answer.
  useEffect(() => { void actions.compose.refreshImageInput(); }, [actions]);
  useRequestSignal(attachSerial, () => fileRef.current?.click());
  const rewriting = draft.retake?.rewrite !== undefined;
  const attachRefusal = !imageInputEntryPointsOpen()
    ? "Image input is not available"
    : rewriting
      ? "An image cannot go with a rewrite"
      : imageInput === null
        ? "Checking image support"
        : imageInput.support === "supported" ? null : imageInputRefusalMessage(imageInput);
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    void actions.compose.attachImages(storyId, [...event.dataTransfer.files]);
  };

  const text = visibleComposeText(draft);
  const retakeNumber = story !== null && draft.retake !== null
    ? story.payload.path.findIndex((node) => node.id === draft.retake?.nodeId) + 1
    : 0;
  const excerpt = draft.retake?.rewrite === undefined ? "" : excerptOf(draft.retake.rewrite.expected);
  const head = draft.retake === null
    ? (story === null ? "" : continuationTargetLabel(story.payload, effectiveFocusedPartId(story), text))
    : draft.retake.rewrite !== undefined
      ? (retakeNumber > 0 ? `Rewrite “${excerpt}” in part ${retakeNumber} — instruction` : "Rewrite — that part is no longer on the line")
      : (retakeNumber > 0 ? `Retake part ${retakeNumber} — new direction` : "Retake — that part is no longer on the line");

  /** Hands the keyboard back to the manuscript. */
  const leave = (): void => {
    fieldRef.current?.blur();
    focusCurrentPart();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // An input method is composing text: Enter and Escape belong to it.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      // Load-bearing: without it the window listener in `app/keymap.ts` would
      // also stop a running generation on this same press.
      event.preventDefault();
      // An open context breakdown closes first; the retake and the box stay.
      if (store.get().context.expanded) {
        actions.context.setExpanded(false);
        return;
      }
      if (draft.retake !== null) actions.compose.cancelRetake(storyId);
      leave();
      return;
    }
    const chord = resolveComposeBinding(event.nativeEvent);
    if (chord?.action === "toggle-context-meter") {
      event.preventDefault();
      actions.context.toggleExpanded();
      return;
    }
    if (chord?.action === "open-request") {
      event.preventDefault();
      openStoryPage(storyId, { kind: "request" });
      return;
    }
    if (chord?.action === "history-previous" || chord?.action === "history-next") {
      event.preventDefault();
      actions.compose.historyMove(storyId, chord.action === "history-previous" ? -1 : 1);
      return;
    }
    const plain = !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
    if (event.key === "Enter" && plain) {
      event.preventDefault();
      if (actions.compose.submit(storyId)) leave();
      return;
    }
    // ⌃↑ is Mission Control on macOS, so plain ↑ and ↓ walk the history when
    // the box is empty, or when a walk is on and the text is one line.
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain
      && (text.length === 0 || (browsing && !text.includes("\n")))) {
      event.preventDefault();
      actions.compose.historyMove(storyId, event.key === "ArrowUp" ? -1 : 1);
    }
  };

  return (
    <div className="composer" onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={onDrop}>
      <div className="composer-head">
        <span className="composer-target">{head}</span>
        <span className="composer-head-end">
          {status !== null && status.length > 0
            ? <span className="generation-status">{status}</span>
            : <span className="composer-hint">Enter to send · Shift+Enter new line</span>}
          <ContextMeter storyId={storyId} />
        </span>
      </div>
      {draft.images.length > 0 && <Suspense fallback={null}><ImageChips storyId={storyId} images={draft.images} /></Suspense>}
      <div className="composer-row">
        <input
          ref={fileRef}
          type="file"
          className="composer-file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void actions.compose.attachImages(storyId, files);
          }}
        />
        <button
          type="button"
          className="icon-btn composer-attach"
          aria-label="Attach image"
          title={attachRefusal ?? "Attach image"}
          disabled={attachRefusal !== null}
          onClick={() => fileRef.current?.click()}
        >
          <Icon path={ICONS.image} />
        </button>
        <textarea
          ref={fieldRef}
          className="composer-field"
          rows={1}
          value={text}
          placeholder={draft.retake === null ? "What happens next?" : rewriting ? "How should this passage change?" : "How should this part go instead?"}
          aria-label={draft.retake === null ? "What happens next?" : rewriting ? "Instruction for the rewrite" : "New direction for the retake"}
          aria-keyshortcuts="Enter"
          spellCheck
          onChange={(event) => actions.compose.setText(storyId, event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="generation-bar-actions">{children}</div>
      </div>
    </div>
  );
}
