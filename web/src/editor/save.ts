import { apiErrorCode } from "../../../client/api-error.js";
import { textHash, type StoryApi } from "../../../client/api.js";
import type { StoryNode, StoryPayload } from "../../../shared/types.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import { outcomeUnknown } from "../app/story-mutation.js";

/**
 * The editor's API calls, with the conflict and unknown-outcome handling the
 * TUI's `editor-action.ts` gets from its backend runner. Pure over `api`, like
 * `generation/settle.ts`: no store, no toast. The caller decides what the
 * outcome shows.
 */
export type EditorSaveRequest =
  /** `e`, primary: copy the part into a new take with the edit applied. */
  | {
      readonly kind: "fork";
      readonly storyId: string;
      readonly base: StoryNode;
      readonly instruction: string;
      readonly text: string;
      readonly knownNodeIds: ReadonlySet<string>;
    }
  /** `e`, secondary: change the part itself. `patch` has only the fields that
   * changed. */
  | {
      readonly kind: "in-place";
      readonly storyId: string;
      readonly base: StoryNode;
      readonly patch: { instruction?: string; text?: string };
    }
  /** A chapter summary's text, changed in place. `expected` is the text the
   * editor opened on (the server refuses the change if it moved). */
  | {
      readonly kind: "summary";
      readonly storyId: string;
      readonly summaryId: string;
      readonly text: string;
      readonly expected: string;
    }
  /** `w`: the writer's own take next to a part (`parentId` of that part). */
  | {
      readonly kind: "write";
      readonly storyId: string;
      readonly parentId: string | null;
      readonly instruction: string;
      readonly text: string;
      readonly knownNodeIds: ReadonlySet<string>;
    };

export type EditorSaveOutcome =
  /** `landedId` is the saved part (the new take, or the edited part). */
  | { readonly kind: "saved"; readonly payload: StoryPayload; readonly landedId: string | null }
  /** The part or the story changed since the editor opened. `payload` is the
   * reload, `null` if the reload failed too. The draft is kept. */
  | { readonly kind: "conflict"; readonly payload: StoryPayload | null }
  /** Nothing is known to be saved. `payload` is the reload (`null` if it
   * failed). The draft is kept. */
  | { readonly kind: "failed"; readonly payload: StoryPayload | null; readonly error: unknown }
  /** The call may have committed, and the check that would tell could not
   * finish. The editor keeps the request as evidence and must settle it
   * (`reconcileEditor`) before it creates anything again — a second create
   * after a lost answer would write the text twice. */
  | { readonly kind: "unresolved"; readonly payload: StoryPayload | null; readonly error: unknown }
  /** `reconcileEditor` only: the check finished, and the earlier call left
   * nothing behind. It is safe to send again. */
  | { readonly kind: "absent"; readonly payload: StoryPayload };

/** What looking for an earlier call's result found. */
type Resolution =
  | { readonly kind: "found"; readonly id: string | null }
  | { readonly kind: "absent" }
  | { readonly kind: "unresolved" };

const CONFLICT_CODES: ReadonlySet<string | null> = new Set(["conflict", "revision_conflict"]);

export async function saveEditor(api: StoryApi, request: EditorSaveRequest): Promise<EditorSaveOutcome> {
  try {
    const payload = await send(api, request);
    return { kind: "saved", payload, landedId: await landedIdOf(api, request, payload) };
  } catch (error) {
    // Always reload after a failure: a failed call can still move the story's
    // version, and the reload is how an unknown outcome is settled.
    const reloaded = await api.loadStory(request.storyId).catch(() => null);
    if (CONFLICT_CODES.has(apiErrorCode(error))) return { kind: "conflict", payload: reloaded };
    if (outcomeUnknown(error)) {
      const resolution: Resolution = reloaded === null
        ? { kind: "unresolved" }
        : await resolveEarlierCall(api, request, reloaded);
      if (resolution.kind === "found") return { kind: "saved", payload: reloaded!, landedId: resolution.id };
      // Only a create can be written twice; an in-place edit sent again is
      // answered with a conflict if the first one landed.
      if (resolution.kind === "unresolved" && (request.kind === "fork" || request.kind === "write")) {
        return { kind: "unresolved", payload: reloaded, error };
      }
    }
    return { kind: "failed", payload: reloaded, error };
  }
}

/** Settles an earlier unresolved call: reload, then look for its result. Used
 * by the next Save before it may create anything again. */
export async function reconcileEditor(api: StoryApi, request: EditorSaveRequest): Promise<EditorSaveOutcome> {
  const reloaded = await api.loadStory(request.storyId).catch(() => null);
  if (reloaded === null) {
    return { kind: "unresolved", payload: null, error: new Error("The story could not be reloaded.") };
  }
  const resolution = await resolveEarlierCall(api, request, reloaded);
  if (resolution.kind === "found") return { kind: "saved", payload: reloaded, landedId: resolution.id };
  if (resolution.kind === "absent") return { kind: "absent", payload: reloaded };
  return { kind: "unresolved", payload: reloaded, error: new Error("The earlier save could not be checked.") };
}

async function send(api: StoryApi, request: EditorSaveRequest): Promise<StoryPayload> {
  if (request.kind === "fork") {
    const expectedTextHash = await textHash(request.base.text);
    return await retryWhenBusy(() => api.createNode(request.storyId, {
      sourceNodeId: request.base.id,
      expectedTextHash,
      instruction: request.instruction,
      text: request.text
    }));
  }
  if (request.kind === "in-place") {
    return await retryWhenBusy(() => api.editNode(request.storyId, request.base, request.patch));
  }
  if (request.kind === "summary") {
    return await retryWhenBusy(() => api.editChapterSummary(request.storyId, request.summaryId, request.text, request.expected));
  }
  return await retryWhenBusy(() => api.createNode(request.storyId, {
    parentId: request.parentId,
    ...(request.parentId === null ? { instruction: request.instruction } : {}),
    text: request.text
  }));
}

function parentOf(request: EditorSaveRequest): string | null {
  return request.kind === "write" ? request.parentId : request.kind === "fork" ? request.base.parentId : null;
}

/** The new take a successful create returned: found among the unknown nodes
 * under the right parent, by exact text and direction. A success payload is
 * the server's own answer, so a missing take is not an error — focus just
 * stays where it is. */
async function landedIdOf(
  api: StoryApi,
  request: EditorSaveRequest,
  payload: StoryPayload
): Promise<string | null> {
  if (request.kind === "in-place") return request.base.id;
  // A summary is not on the line: there is no part to focus.
  if (request.kind === "summary") return null;
  const found = await findExactNewTake(api, request, payload);
  return found.kind === "found" ? found.id : null;
}

/** After an unknown outcome: did the reload show the change? An in-place edit
 * is saved when the reloaded part holds exactly the submitted text and
 * direction. A new take is saved only when a node that did not exist before
 * holds exactly the submitted text and direction: the stub's preview and word
 * count only nominate a candidate, and the candidate's full text decides. A
 * sibling written in another window with the same start never counts. A
 * candidate whose full text could not be read leaves the answer open. */
async function resolveEarlierCall(
  api: StoryApi,
  request: EditorSaveRequest,
  reloaded: StoryPayload
): Promise<Resolution> {
  if (request.kind === "summary") {
    const node = reloaded.nodes.find((candidate) => candidate.id === request.summaryId);
    return node?.text === request.text ? { kind: "found", id: node.id } : { kind: "absent" };
  }
  if (request.kind === "in-place") {
    const node = reloaded.path.find((candidate) => candidate.id === request.base.id);
    if (node === undefined) return { kind: "absent" };
    const text = request.patch.text ?? request.base.text;
    const instruction = request.patch.instruction ?? request.base.instruction;
    return node.text === text && node.instruction === instruction
      ? { kind: "found", id: node.id }
      : { kind: "absent" };
  }
  return await findExactNewTake(api, request, reloaded);
}

const MAX_CANDIDATES = 8;

async function findExactNewTake(
  api: StoryApi,
  request: Exclude<EditorSaveRequest, { kind: "in-place" | "summary" }>,
  payload: StoryPayload
): Promise<Resolution> {
  const parentId = parentOf(request);
  const exact = (node: { readonly text: string; readonly instruction: string }): boolean =>
    node.text === request.text && node.instruction === request.instruction;
  const onPath = payload.path.find((node) =>
    !request.knownNodeIds.has(node.id) && node.parentId === parentId && exact(node));
  if (onPath !== undefined) return { kind: "found", id: onPath.id };
  const candidates = payload.nodes
    .filter((node) => !request.knownNodeIds.has(node.id) && node.parentId === parentId
      && !payload.path.some((onLine) => onLine.id === node.id))
    .slice(-MAX_CANDIDATES);
  let unread = false;
  for (const candidate of candidates) {
    // The stub has only a preview; the take's own line has its full text.
    const line = await api.getTakeLine(request.storyId, candidate.id).catch(() => null);
    if (line === null) {
      unread = true;
      continue;
    }
    const full = line.parts.at(-1);
    if (full !== undefined && full.id === candidate.id && exact(full)) return { kind: "found", id: candidate.id };
  }
  return unread ? { kind: "unresolved" } : { kind: "absent" };
}
