import { factDraftOf } from "../../../shared/fact-draft.js";
import { canonicalFactStates, factStateText, isFactEndState, isFactStateful, type FactState } from "../../../shared/fact-state.js";
import { factPathProjection } from "../../../shared/fact-view.js";
import type { StoryFact, StoryPayload } from "../../../shared/types.js";
import { formOfDraft, EMPTY_FACT_FORM, type FactForm } from "./form.js";
import type { FactEditor } from "./state.js";

/** How each editor opens: on a fact (on the state in effect), on a new fact,
 * or on a new state. Pure. */

const FRESH = { saving: false, overwriteArmed: false, discardArmed: false, pending: null } as const;

export function formOfFactState(fact: StoryFact, state: FactState | null): FactForm {
  const draft = factDraftOf(fact);
  return formOfDraft(state === null ? draft : { ...draft, text: factStateText(state) ?? "" });
}

/** The state an editor opens on: the one in effect on this line, else the
 * first one. */
export function stateInEffect(fact: StoryFact, payload: StoryPayload): FactState {
  const projection = factPathProjection(fact, payload.path.map((node) => node.id));
  return projection.resolution.kind === "off-path"
    ? projection.states.find((state) => !isFactEndState(state)) ?? projection.states[0]!
    : projection.resolution.state;
}

export function editorOnState(storyId: string, fact: StoryFact, state: FactState): FactEditor {
  const form = formOfFactState(fact, state);
  return {
    storyId, factId: fact.id, newAnchorPartId: null, base: form, form, ...FRESH,
    body: {
      kind: "state",
      stateId: state.id,
      anchorPartId: state.anchorPartId ?? null,
      ends: isFactEndState(state),
      baseText: form.text
    }
  };
}

export function editorOnFact(storyId: string, fact: StoryFact, payload: StoryPayload): FactEditor {
  if (isFactStateful(fact)) return editorOnState(storyId, fact, stateInEffect(fact, payload));
  const form = formOfFactState(fact, null);
  return { storyId, factId: fact.id, newAnchorPartId: null, base: form, form, ...FRESH, body: { kind: "fact" } };
}

export function editorOnNewFact(storyId: string, options: { readonly text?: string; readonly anchorPartId?: string | null }): FactEditor {
  return {
    storyId, factId: null, newAnchorPartId: options.anchorPartId ?? null,
    base: EMPTY_FACT_FORM, form: { ...EMPTY_FACT_FORM, text: options.text ?? "" }, ...FRESH,
    body: { kind: "fact" }
  };
}

/** A state that does not exist yet, anchored at `anchorPartId` (`null` for
 * story-wide). A text state starts from the text in effect. */
export function editorOnNewState(
  storyId: string,
  fact: StoryFact,
  payload: StoryPayload,
  anchorPartId: string | null,
  ends: boolean
): FactEditor {
  const current = factPathProjection(fact, payload.path.map((node) => node.id)).displayText;
  const base = formOfFactState(fact, null);
  const text = ends ? "" : current;
  return {
    storyId, factId: fact.id, newAnchorPartId: null, base: { ...base, text }, form: { ...base, text }, ...FRESH,
    body: { kind: "new-state", anchorPartId, ends, baseText: text }
  };
}

export function statesOf(fact: StoryFact): readonly FactState[] {
  return canonicalFactStates(fact);
}
