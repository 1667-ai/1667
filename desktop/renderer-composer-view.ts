/** The composer (D-12, Write): rest (one line), typing (a titled field),
 * blocked (streaming or a stopped generation pending), and the
 * stopped-generation card that docks above it. */
import { imageMediaTypeLabel } from "../shared/image-attachment.js";
import { actionButton, bindDraftInput, el, resizeTextarea } from "./renderer-dom.js";
import type { ComposerMode, RendererActions, RendererState } from "./renderer-model.js";

const MODES: readonly { readonly mode: ComposerMode; readonly label: string }[] = [
  { mode: "continue", label: "Continue" },
  { mode: "direct", label: "Direct" },
  { mode: "write", label: "Write it myself" }
];

export function eyebrowFor(mode: ComposerMode): string {
  if (mode === "direct") return "DIRECT · A NEW TAKE FROM THIS DIRECTION";
  if (mode === "write") return "WRITE · YOUR OWN WORDS";
  return "CONTINUE · DIRECTION FOR THE NEXT PART";
}

export function submitLabel(mode: ComposerMode, empty: boolean): string {
  if (mode === "write") return "Save line ⌘↵";
  if (mode === "direct") return "Write take ⌘↵";
  return empty ? "Continue ↵" : "Continue ⌘↵";
}

export function renderComposer(state: RendererState, actions: RendererActions): HTMLElement {
  const composer = document.createElement("form");
  const draftValue = state.drafts.composer ?? "";
  const empty = draftValue.trim().length === 0;
  const blocked = state.stream !== null || state.stoppedGeneration !== null;
  composer.className = `composer${empty ? "" : " composer-typing"}${blocked ? " blocked" : ""}`;

  if (state.stoppedGeneration !== null) composer.append(renderStoppedGeneration(state.stoppedGeneration, actions));

  composer.append(el("p", "composer-eyebrow", blocked ? "writing… · esc stops" : eyebrowFor(state.composerMode)));

  const modeGroup = el("div", "composer-mode");
  for (const entry of MODES) {
    const button = actionButton(`composer-mode-${entry.mode}`, entry.label, () => actions.setComposerMode(entry.mode));
    button.classList.toggle("active", state.composerMode === entry.mode);
    button.disabled = blocked;
    modeGroup.append(button);
  }

  const prompt = document.createElement("textarea");
  prompt.className = "composer-input";
  prompt.placeholder = "› Empty ↵ continues · type a direction for a new take";
  prompt.setAttribute("aria-label", "Generation direction");
  prompt.dataset.preserve = "composer";
  prompt.value = draftValue;
  prompt.rows = Math.max(1, Math.min(10, prompt.value.split("\n").length + 1));
  prompt.disabled = blocked;
  bindDraftInput(prompt, () => {
    actions.setDraft("composer", prompt.value);
    resizeTextarea(prompt);
  });

  const submit = actionButton("composer-submit", submitLabel(state.composerMode, empty), () => {
    if (blocked) return;
    if (state.composerMode === "write") {
      if (prompt.value.trim().length > 0) actions.writeManual(prompt.value);
      return;
    }
    actions.continueStory(state.composerMode === "direct" ? "direct" : "continue", prompt.value);
  });
  submit.disabled = blocked;
  prompt.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submit.click();
    }
  });

  const manual = actionButton("composer-manual", "Save as my own line", () => {
    if (!blocked && prompt.value.trim().length > 0) actions.writeManual(prompt.value);
  });
  manual.disabled = blocked;

  const imageInput = document.createElement("input");
  imageInput.type = "file";
  imageInput.accept = "image/png,image/jpeg,image/webp";
  imageInput.hidden = true;
  imageInput.addEventListener("change", () => {
    const file = imageInput.files?.[0];
    imageInput.value = "";
    if (file !== undefined) actions.attachImage(file);
  });
  const attach = actionButton("composer-attach-image", "Attach image", () => imageInput.click());
  attach.disabled = blocked;

  const images = el("div", "composer-images");
  state.draftImages.forEach((image, index) => {
    images.append(
      el("span", "image-chip", `Image ${index + 1} · ${imageMediaTypeLabel(image.attachment.mediaType)} · ${image.attachment.width}×${image.attachment.height}`),
      actionButton("composer-remove-image", "Remove", () => actions.removeImage(index))
    );
  });

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.click();
  });
  // The stylesheet places the field on its own row above the mode switch and verbs.
  const row = el("div", "composer-row", modeGroup, prompt, el("div", "composer-footer", attach, manual, submit));
  composer.append(
    row,
    el("p", "composer-hint", "⇧↵ newline · ⌘↵ send · esc"),
    images,
    imageInput
  );
  return composer;
}

function renderStoppedGeneration(stopped: NonNullable<RendererState["stoppedGeneration"]>, actions: RendererActions): HTMLElement {
  const summary = stopped.mode === "summary";
  const rewriteUnavailable = stopped.saveable === false;
  const eyebrow = summary
    ? "INTERRUPTED SUMMARY"
    : `INTERRUPTED GENERATION · ${stopped.text.length.toLocaleString()} CHARACTERS KEPT`;
  const card = el("div", "stopped-generation",
    el("span", "eyebrow", eyebrow),
    el("p", "stopped-generation-text", stopped.text),
    el("p", "", summary
      ? "This summary is kept for review. It is not saved as story prose."
      : rewriteUnavailable
        ? "The Host no longer has this rewrite. Copy the retained text before you discard it."
        : `${stopped.text.length.toLocaleString()} characters are ready to save as provider output.`)
  );
  if (summary) card.append(actionButton("stopped-discard", "Discard summary", actions.discardStoppedGeneration));
  else if (rewriteUnavailable) card.append(actionButton("stopped-copy", "Copy text", actions.copyStoppedGeneration), actionButton("stopped-discard", "Discard", actions.discardStoppedGeneration));
  else card.append(actionButton("stopped-save", "Save interrupted text", actions.saveStoppedGeneration), actionButton("stopped-discard", "Discard", actions.discardStoppedGeneration));
  return card;
}
