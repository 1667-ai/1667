import type { CreateNodeRequest, Story } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import { currentModel } from "./generation-http.js";
import type { GenerationAdmissionRegistry } from "./generation-admission.js";
import { DEFAULT_INSTRUCTION } from "./generation-prompts.js";
import type { SettingsStore } from "./settings.js";
import { commitTake, createEditedTake } from "./story-nodes.js";
import type { StoryStore } from "./stories.js";

/** One take to write. A `nodeId` that the story already holds writes nothing,
 * which is what makes a repeated commit repair rather than duplicate. */
export interface NodeCommit {
  readonly body: CreateNodeRequest;
  readonly nodeId?: string;
}

interface NodeCommitDependencies {
  readonly stories: StoryStore;
  readonly settings: SettingsStore;
  readonly generationAdmission: GenerationAdmissionRegistry;
}

/** A take whose request is accepted. Preparation stays outside the story lock,
 * so an invalid request fails before it can hold the lock. */
interface PreparedTake {
  readonly body: CreateNodeRequest;
  readonly nodeId: string | undefined;
  readonly genId: string | null;
  readonly instruction: string;
  readonly rawText: string;
}

function prepareTake(commit: NodeCommit): PreparedTake {
  const rawText = commit.body.text;
  if (rawText.trim().length === 0) throw new ServiceError(400, "Nothing to save");
  const genId = commit.body.genId ?? null;
  const providedInstruction = commit.body.instruction ?? "";
  return {
    body: commit.body,
    nodeId: commit.nodeId,
    genId,
    instruction: genId === null
      ? providedInstruction
      : providedInstruction.trim() || DEFAULT_INSTRUCTION,
    rawText
  };
}

/** Apply one take to a loaded story. Reports whether the story changed, so the
 * caller writes the aggregate once for however many takes it applied. */
async function applyTake(
  dependencies: NodeCommitDependencies,
  id: string,
  story: Story,
  take: PreparedTake
): Promise<boolean> {
  const { stories, settings, generationAdmission } = dependencies;
  const { body, nodeId, genId, instruction, rawText } = take;
  if (nodeId !== undefined && story.nodes.some((node) => node.id === nodeId)) {
    return false;
  }
  if (body.sourceNodeId !== undefined) {
    await stories.hydratePath(story, body.sourceNodeId);
    createEditedTake(
      story,
      body.sourceNodeId,
      body.expectedTextHash,
      instruction,
      rawText.trim(),
      nodeId
    );
    return true;
  }
  const model = genId === null
    ? "human"
    : generationAdmission.modelFor(id, genId) ?? await currentModel(settings);
  const requestedAppendTo = body.appendTo ?? null;
  const appendCrossesBreak = requestedAppendTo !== null
    && story.chapterBreaks.some((chapterBreak) => chapterBreak.parentPartId === requestedAppendTo);
  const appendTo = appendCrossesBreak ? null : requestedAppendTo;
  const expectedTextHash = appendTo !== null && body.appendTo !== undefined
    ? body.expectedTextHash
    : null;
  const parentId = body.parentId ?? null;
  const { duplicate } = commitTake(story, {
    parentId: appendCrossesBreak ? requestedAppendTo : appendTo === null ? parentId : null,
    appendTo,
    expectedTextHash,
    instruction,
    text: appendTo === null ? rawText.trim() : rawText,
    model,
    genId,
    ...(nodeId === undefined ? {} : { nodeId })
  });
  return !duplicate;
}

/** One locked commit path for human takes, generated takes, appends, and
 * edit-as-sibling. Keeping this out of StoryService leaves transport
 * orchestration separate from node mutation policy. */
export async function commitNode(
  stories: StoryStore,
  settings: SettingsStore,
  generationAdmission: GenerationAdmissionRegistry,
  id: string,
  body: CreateNodeRequest,
  mutationNodeId?: string
): Promise<Story> {
  return await commitNodes(stories, settings, generationAdmission, id, [
    { body, ...(mutationNodeId === undefined ? {} : { nodeId: mutationNodeId }) }
  ]);
}

/**
 * Write several takes as one aggregate change.
 *
 * Each take goes through the same policy as a single commit, so the takes land
 * in whatever schema the build currently writes. What the batch removes is one
 * manifest publication per take: a caller that already knows every take, such
 * as the starter vault, pays a single durable write instead of one for each.
 *
 * The mutation-receipt path stays one take per request, because a receipt
 * covers one client request.
 */
export async function commitNodes(
  stories: StoryStore,
  settings: SettingsStore,
  generationAdmission: GenerationAdmissionRegistry,
  id: string,
  commits: readonly NodeCommit[]
): Promise<Story> {
  const prepared = commits.map(prepareTake);
  const dependencies = { stories, settings, generationAdmission };
  return await stories.withLock(id, async () => {
    const story = await stories.loadForMutation(id);
    let changed = false;
    for (const take of prepared) {
      if (await applyTake(dependencies, id, story, take)) changed = true;
    }
    if (changed) await stories.save(story);
    return story;
  });
}
