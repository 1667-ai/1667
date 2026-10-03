import type { FactScopeFilter } from "../../../shared/fact-view.js";
import type { FactInput } from "../../../shared/types.js";
import { changedFields, type FactForm } from "./form.js";

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
  /** An existing state. `baseText` is its text as the editor opened. */
  | {
      readonly kind: "state";
      readonly stateId: string;
      readonly anchorPartId: string | null;
      readonly ends: boolean;
      readonly baseText: string;
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

/** True when the writer has typed something that closing would throw away. */
export function factEditorDirty(editor: FactEditor): boolean {
  if (changedFields(editor.base, editor.form).some((field) => field !== "text")) return true;
  const body = editor.body;
  if (body.kind === "fact") return editor.form.text !== editor.base.text;
  if (body.ends) return false;
  return editor.form.text !== body.baseText;
}

/** Everything the editor holds, as one text to copy. */
export function factEditorCopyText(editor: FactEditor): string {
  const { name, tag, keys, text } = editor.form;
  const head = [
    name.trim().length > 0 ? `Name: ${name.trim()}` : "",
    tag.trim().length > 0 ? `Tag: ${tag.trim()}` : "",
    keys.trim().length > 0 ? `Keys: ${keys.trim()}` : ""
  ].filter((line) => line.length > 0);
  return head.length === 0 ? text : `${head.join("\n")}\n\n${text}`;
}
