/** Owns the one document-level keydown listener: the desktop-only ⌘ chords
 * (§4), Escape's peel order — popover, dialog, focused field, then Map back
 * to Write (§5) — and the TUI keymap dispatch (§2-3). Extracted from
 * `RendererApp` so `renderer.ts` does not grow further; mirrors the existing
 * `RendererShellController`/`RendererSettingsController` hook pattern. */
import type { StoryPathNode } from "../shared/types.js";
import { buildDesktopCommandContext, commandForAction } from "./renderer-commands.js";
import { activatesOnEnterOrSpace, fieldHasFocus, resolveDesktopBinding } from "./renderer-keymap.js";
import { currentAsideHopTakeId } from "./renderer-aside-popover-view.js";
import { effectiveFocusedPartId, type RendererActions, type RendererState, type RendererTab } from "./renderer-model.js";

export interface RendererKeysHooks {
  readonly state: () => RendererState;
  readonly actions: () => RendererActions;
  readonly setTab: (tab: RendererTab) => void;
  readonly closeDialog: () => void;
  readonly saveDirtyPart: (node: StoryPathNode, text: string) => void;
  readonly hasDirtySettings: () => boolean;
  readonly saveSettingsDraft: () => void;
  readonly hasDirtyFactEditor: () => boolean;
  readonly saveFactEditorDraft: () => void;
}

const DESTINATION_TABS: readonly RendererTab[] = ["library", "write", "facts", "chapters", "map", "inspect"];

export class RendererKeysController {
  public constructor(private readonly hooks: RendererKeysHooks) {}

  public start(): void {
    document.addEventListener("keydown", (event) => this.handleKeydown(event));
  }

  private handleKeydown(event: KeyboardEvent): void {
    // A control that already handled this key (a scalar's chevron or drag
    // handle, the settings-section nav) calls `preventDefault()` itself;
    // respect that instead of also running a NAV command for the same key.
    if (event.defaultPrevented) return;
    // Desktop-only chords (§4): ⌘ on macOS, Ctrl elsewhere, regardless of
    // field focus — the same cross-platform convention the destination
    // chords already used.
    if (event.metaKey || event.ctrlKey) {
      if (/^[1-6]$/u.test(event.key)) {
        event.preventDefault();
        this.hooks.setTab(DESTINATION_TABS[Number(event.key) - 1]!);
        return;
      }
      if (event.key === ",") {
        event.preventDefault();
        this.hooks.setTab("settings");
        return;
      }
      if (event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        this.hooks.actions().openPalette();
        return;
      }
      if (event.key.toLocaleLowerCase() === "s") {
        event.preventDefault();
        this.saveCurrentEdit();
        return;
      }

    }
    // Escape peels one layer: popover, then dialog, then a focused field,
    // then (in Map) back to Write. Runs even with a field focused.
    if (event.key === "Escape") {
      event.preventDefault();
      this.peelEscape();
      return;
    }
    // ⌘ is the desktop's own layer; the TUI keymap never resolves under it.
    if (event.metaKey) return;
    // Letters (and the TUI's other plain/chord keys) act only when no field
    // owns the keyboard — typing must reach the field instead.
    if (fieldHasFocus()) return;
    // The aside popover's own `g` ("go to this take") shadows NAV's `g`
    // ("jump to the first part") while it is open — the popover is not a
    // destination, so the keymap dispatch below never sees it otherwise.
    if (this.hooks.state().popover?.kind === "aside" && event.key.toLowerCase() === "g" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      this.goToCurrentAsideHopTake();
      return;
    }
    // Enter/Space already activate a focused button or link (a Library story
    // row, a rail icon); let that native click through instead of resolving
    // `compose`/`continue` out from under it.
    if ((event.key === "Enter" || event.key === " ") && activatesOnEnterOrSpace()) return;
    const mode: "NAV" | "MAP" = this.hooks.state().tab === "map" ? "MAP" : "NAV";
    const binding = resolveDesktopBinding(event, mode);
    if (binding === null) return;
    const command = commandForAction(binding.action, mode);
    if (command === undefined) return;
    const ctx = buildDesktopCommandContext(this.hooks.state(), this.hooks.actions(), binding);
    if (!command.available(ctx)) return;
    event.preventDefault();
    command.run(ctx);
  }

  /** Escape peels one layer: a running stream first (it is the outermost
   * layer — it stops even under an open popover or dialog), then an open
   * popover, then a dialog, then a part mid-edit (leaves edit mode, keeps
   * the draft), then a focused field (blur it — the toast already clears on
   * any keydown), then, in Map, back to Write at the same focused part. */
  private peelEscape(): void {
    const state = this.hooks.state();
    if (state.stream !== null) {
      this.hooks.actions().stopStream();
      return;
    }
    if (state.popover !== null) {
      this.hooks.actions().closePopover();
      return;
    }
    if (state.dialog !== null) {
      this.hooks.closeDialog();
      return;
    }
    if (state.editingPartId !== null) {
      this.hooks.actions().editPart(null);
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    if (fieldHasFocus()) {
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    if (state.tab === "map") this.hooks.setTab("write");
  }

  /** ⌘S: save the focused part's edit when its textarea is dirty, else the
   * Facts sheet's draft when on Facts, else the settings draft when on
   * Settings, else nothing. Public so the palette's "Save the current edit"
   * command (chord display only — it does not run through the keymap
   * dispatch) can call the same logic. */
  public saveCurrentEdit(): void {
    const state = this.hooks.state();
    const story = state.story;
    // Only Write owns the manuscript editor; a part draft left behind after
    // Escape must not steal ⌘S from whatever editor is actually visible.
    if (state.tab === "write" && story !== null) {
      const focusedId = effectiveFocusedPartId(state, story);
      const node = focusedId === null ? null : story.path.find((candidate) => candidate.id === focusedId) ?? null;
      if (node !== null) {
        const text = state.drafts[`part:${node.id}`];
        if (text !== undefined && text !== node.text) {
          this.hooks.saveDirtyPart(node, text);
          return;
        }
      }
    }
    if (state.tab === "facts" && this.hooks.hasDirtyFactEditor()) {
      this.hooks.saveFactEditorDraft();
      return;
    }
    if (state.tab === "settings" && this.hooks.hasDirtySettings()) this.hooks.saveSettingsDraft();
  }

  private goToCurrentAsideHopTake(): void {
    const actions = this.hooks.actions();
    const takeId = currentAsideHopTakeId(this.hooks.state().aside);
    if (takeId === null) {
      actions.toast("No take for this session");
      return;
    }
    actions.switchNode(takeId);
  }
}
