import type { FactScopeFilter } from "../../../shared/fact-view.js";
import type { FactInput } from "../../../shared/types.js";
import type { FactForm } from "./form.js";

/**
 * The Facts view's state (#409 step 7b and 7c): the list filter, the one open
 * fact editor, and the "pick a fact" mode a part-menu action starts. The
 * editor's draft lives here, in the store, so a re-render, a closed panel, a
 * route change, or a refused save never loses it; the unsaved-work list reads
 * it from here.
 */

/** What the editor's body field holds. A Fact with one story-wide text keeps
 * its text on the Fact itself; any other Fact edits one state at a time. */
export type FactBody =
  | { readonly kind: "fact" }
  /** An existing state. `baseText`, `baseAnchorPartId` and `baseEnds` are the
   * state as the editor opened; `anchorPartId` and `ends` are the draft (re-anchor
   * and convert change them). */
  | {
      readonly kind: "state";
      readonly stateId: string;
      readonly anchorPartId: string | null;
      readonly ends: boolean;
      readonly baseText: string;
      readonly baseAnchorPartId: string | null;
      readonly baseEnds: boolean;
      /** The text typed before Convert to end, kept until Convert to text brings it back. */
      readonly heldText?: string;
    }
  /** A state that does not exist yet. `baseText` is what the body started with. */
  | {
      readonly kind: "new-state";
      readonly anchorPartId: string | null;
      readonly ends: boolean;
      readonly baseText: string;
    };

/** A create that may have committed, whose check could not finish. The next
 * Save settles it before it sends anything, so the fact is never made twice. */
export interface PendingFactCreate {
  readonly input: FactInput;
  readonly knownFactIds: readonly string[];
  /** The form that was sent. */
  readonly form: FactForm;
}

export interface FactEditor {
  readonly storyId: string;
  /** `null` while the fact is new. */
  readonly factId: string | null;
  /** The part a new fact's first state is anchored to ("Fact from here"). */
  readonly newAnchorPartId: string | null;
  /** The form as the editor opened (or as last saved). */
  readonly base: FactForm;
  readonly form: FactForm;
  readonly body: FactBody;
  readonly saving: boolean;
  /** A conflict reloaded the fact; the next Save overwrites its newer fields. */
  readonly overwriteArmed: boolean;
  /** The first Escape on a changed editor; the second one discards. */
  readonly discardArmed: boolean;
  readonly pending: PendingFactCreate | null;
}

export interface FactsFilter {
  readonly scope: FactScopeFilter;
  readonly tag: string | null;
  readonly query: string;
  /** Only the facts with a state at this part (the ◆ mark's filter). */
  readonly anchorPartId: string | null;
}

/** A part-menu action that needs a fact: the panel lists the facts and the
 * next pick finishes the action at `partId`. */
export interface FactPick {
  readonly storyId: string;
  readonly action: "new-state" | "end";
  readonly partId: string;
}

export interface FactsState {
  readonly filter: FactsFilter;
  readonly editor: FactEditor | null;
  readonly pick: FactPick | null;
  /** A delete, reorder or budget change is in flight. */
  readonly busy: boolean;
}

export const STATES_UNAVAILABLE_TOAST = "Fact states need a newer backend.";

export function initialFactsState(): FactsState {
  return { filter: { scope: "everywhere", tag: null, query: "", anchorPartId: null }, editor: null, pick: null, busy: false };
}

/** What the shell asks about the open Fact editor. The answers come from the
 * Facts code (`./editor-ops.ts`), which loads when the Facts view first opens.
 * An editor can only exist after that, so until then nothing is changed. */
export interface FactEditorOps {
  dirty(editor: FactEditor): boolean;
  copyText(editor: FactEditor): string;
}

let ops: FactEditorOps | null = null;

export function registerFactEditorOps(registered: FactEditorOps): void {
  ops = registered;
}

/** True when the writer has typed something that closing would throw away. */
export function factEditorDirty(editor: FactEditor): boolean {
  return ops !== null && ops.dirty(editor);
}

/** Everything the editor holds, as one text to copy. */
export function factEditorCopyText(editor: FactEditor): string {
  return ops === null ? "" : ops.copyText(editor);
}
