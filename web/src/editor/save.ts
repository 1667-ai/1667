import { apiErrorCode } from "../../../client/api-error.js";
import { textHash, type StoryApi } from "../../../client/api.js";
import { isExplicitMutationUnsent } from "../../../client/api-error.js";
import { WebBridgeTransportError } from "../../../client/web-bridge-transport.js";
import type { StoryNode, StoryPayload } from "../../../shared/types.js";
import { retryWhenBusy } from "../app/busy-retry.js";

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
  | { readonly kind: "failed"; readonly payload: StoryPayload | null; readonly error: unknown };

const CONFLICT_CODES: ReadonlySet<string | null> = new Set(["conflict", "revision_conflict"]);

/** A failure that does not say whether the change was applied: the bridge
 * says the outcome is uncertain, the transport was lost, or the server says
 * so. This is checked before anything else: a bridge failure with an
 * uncertain outcome still carries a structured envelope, but that envelope is
 * not a verdict on the mutation. A plain structured failure is a verdict; an
 * unsent mutation is a verdict too. */
function outcomeUnknown(error: unknown): boolean {
  if (error instanceof WebBridgeTransportError && error.mutationOutcome === "uncertain") return true;
  if (apiErrorCode(error) === "mutation_outcome_unknown") return true;
  if (isExplicitMutationUnsent(error)) return false;
  const structured = typeof error === "object" && error !== null
    && typeof (error as { failure?: unknown }).failure === "object"
    && (error as { failure?: unknown }).failure !== null;
  return !structured;
}

export async function saveEditor(api: StoryApi, request: EditorSaveRequest): Promise<EditorSaveOutcome> {
  try {
    const payload = await send(api, request);
    return { kind: "saved", payload, landedId: await landedIdOf(api, request, payload) };
  } catch (error) {
    // Always reload after a failure: a failed call can still move the story's
    // version, and the reload is how an unknown outcome is settled.
    const reloaded = await api.loadStory(request.storyId).catch(() => null);
    if (CONFLICT_CODES.has(apiErrorCode(error))) return { kind: "conflict", payload: reloaded };
    if (reloaded !== null && outcomeUnknown(error)) {
      const landedId = await landedAfterUnknown(api, request, reloaded);
      if (landedId !== undefined) return { kind: "saved", payload: reloaded, landedId };
    }
    return { kind: "failed", payload: reloaded, error };
  }
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
  return await findExactNewTake(api, request, payload) ?? null;
}

/** After an unknown outcome: did the reload show the change? An in-place edit
 * is saved when the reloaded part holds exactly the submitted text and
 * direction. A new take is saved only when a node that did not exist before
 * holds exactly the submitted text and direction: the stub's preview and word
 * count only nominate a candidate, and the candidate's full text decides. A
 * sibling written in another window with the same start never counts.
 * `undefined` means not saved. */
async function landedAfterUnknown(
  api: StoryApi,
  request: EditorSaveRequest,
  reloaded: StoryPayload
): Promise<string | null | undefined> {
  if (request.kind === "in-place") {
    const node = reloaded.path.find((candidate) => candidate.id === request.base.id);
    if (node === undefined) return undefined;
    const text = request.patch.text ?? request.base.text;
    const instruction = request.patch.instruction ?? request.base.instruction;
    return node.text === text && node.instruction === instruction ? node.id : undefined;
  }
  return await findExactNewTake(api, request, reloaded);
}

const MAX_CANDIDATES = 8;

async function findExactNewTake(
  api: StoryApi,
  request: Exclude<EditorSaveRequest, { kind: "in-place" }>,
  payload: StoryPayload
): Promise<string | undefined> {
  const parentId = parentOf(request);
  const exact = (node: { readonly text: string; readonly instruction: string }): boolean =>
    node.text === request.text && node.instruction === request.instruction;
  const onPath = payload.path.find((node) =>
    !request.knownNodeIds.has(node.id) && node.parentId === parentId && exact(node));
  if (onPath !== undefined) return onPath.id;
  const candidates = payload.nodes
    .filter((node) => !request.knownNodeIds.has(node.id) && node.parentId === parentId
      && !payload.path.some((onLine) => onLine.id === node.id))
    .slice(-MAX_CANDIDATES);
  for (const candidate of candidates) {
    // The stub has only a preview; the take's own line has its full text.
    const line = await api.getTakeLine(request.storyId, candidate.id).catch(() => null);
    const full = line?.parts.at(-1);
    if (full !== undefined && full.id === candidate.id && exact(full)) return candidate.id;
  }
  return undefined;
}
