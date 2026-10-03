import type { StoryApi } from "../../../client/api.js";
import { canonicalFactStates, isFactEndState, type FactState } from "../../../shared/fact-state.js";
import { firstFactText } from "../../../shared/fact-state.js";
import type {
  FactInput,
  FactPatch,
  FactStateInput,
  FactStatePatch,
  StoryFact,
  StoryPayload
} from "../../../shared/types.js";
import { runStoryMutation, type StoryMutationOutcome } from "../app/story-mutation.js";

/**
 * The fact editor's API calls, with the conflict and unknown-outcome handling
 * every writer shares (`app/story-mutation.ts`). Pure over `api`: no store, no
 * toast. A create is the one call that must never be sent twice after a lost
 * answer, so it can end `unresolved` and the editor keeps it as `pending`.
 */
export type FactSaveRequest =
  | { readonly kind: "create"; readonly storyId: string; readonly input: FactInput; readonly knownFactIds: ReadonlySet<string> }
  /** `landed` says whether a reloaded fact already holds what was sent. */
  | { readonly kind: "patch"; readonly storyId: string; readonly factId: string; readonly patch: FactPatch; readonly landed: (fact: StoryFact) => boolean }
  | {
      readonly kind: "state-patch";
      readonly storyId: string;
      readonly factId: string;
      readonly stateId: string;
      readonly body: FactStatePatch;
      readonly landed: (fact: StoryFact) => boolean;
    }
  | {
      readonly kind: "state-create";
      readonly storyId: string;
      readonly factId: string;
      readonly body: FactStateInput;
      readonly knownStateIds: ReadonlySet<string>;
    };

/** What a landed save left: the fact, and for a state create the new state. */
export interface FactSaveValue {
  readonly factId: string | null;
  readonly stateId: string | null;
}

export const STATES_UNAVAILABLE_TOAST = "Fact states need a newer backend.";

/** Whether `fact` holds a state like the one `body` describes, not among the
 * known ones. */
function newStateOf(fact: StoryFact, body: FactStateInput, known: ReadonlySet<string>): FactState | undefined {
  return canonicalFactStates(fact).find((state) =>
    !known.has(state.id)
    && (state.anchorPartId ?? null) === (body.anchorPartId ?? null)
    && (body.ends === true ? isFactEndState(state) : !isFactEndState(state) && state.text === body.text));
}

/** The fact a create made: a new id with the same name, tag and first text. */
export function createdFact(payload: StoryPayload, input: FactInput, known: ReadonlySet<string>): StoryFact | null {
  return payload.facts.find((fact) =>
    !known.has(fact.id)
    && (fact.name ?? "") === (input.name ?? "")
    && fact.tag === (input.tag ?? null)
    && firstFactText(fact) === input.text) ?? null;
}

export async function runFactSave(api: StoryApi, request: FactSaveRequest): Promise<StoryMutationOutcome<FactSaveValue>> {
  const { storyId } = request;
  switch (request.kind) {
    case "create":
      return await runStoryMutation<FactSaveValue>(
        api,
        storyId,
        async () => {
          const payload = await api.createFact(storyId, request.input);
          return { payload, factId: createdFact(payload, request.input, request.knownFactIds)?.id ?? null, stateId: null };
        },
        (reloaded) => {
          const found = createdFact(reloaded, request.input, request.knownFactIds);
          return found === null ? null : { factId: found.id, stateId: null };
        }
      );
    case "patch":
      return await runStoryMutation<FactSaveValue>(
        api,
        storyId,
        async () => ({ payload: await api.patchFact(storyId, request.factId, request.patch), factId: request.factId, stateId: null }),
        (reloaded) => {
          const fact = reloaded.facts.find((candidate) => candidate.id === request.factId);
          return fact !== undefined && request.landed(fact) ? { factId: fact.id, stateId: null } : null;
        }
      );
    case "state-patch":
      return await runStoryMutation<FactSaveValue>(
        api,
        storyId,
        async () => ({
          payload: await api.patchFactState!(storyId, request.factId, request.stateId, request.body),
          factId: request.factId,
          stateId: request.stateId
        }),
        (reloaded) => {
          const fact = reloaded.facts.find((candidate) => candidate.id === request.factId);
          return fact !== undefined && request.landed(fact) ? { factId: fact.id, stateId: request.stateId } : null;
        }
      );
    case "state-create":
      return await runStoryMutation<FactSaveValue>(
        api,
        storyId,
        async () => {
          const payload = await api.createFactState!(storyId, request.factId, request.body);
          const fact = payload.facts.find((candidate) => candidate.id === request.factId);
          const made = fact === undefined ? undefined : newStateOf(fact, request.body, request.knownStateIds);
          return { payload, factId: request.factId, stateId: made?.id ?? null };
        },
        (reloaded) => {
          const fact = reloaded.facts.find((candidate) => candidate.id === request.factId);
          const made = fact === undefined ? undefined : newStateOf(fact, request.body, request.knownStateIds);
          return made === undefined ? null : { factId: request.factId, stateId: made.id };
        }
      );
  }
}
