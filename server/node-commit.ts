import type { CreateNodeRequest, Story } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import { currentModel } from "./generation-http.js";
import type { GenerationAdmissionRegistry } from "./generation-admission.js";
import { DEFAULT_INSTRUCTION } from "./generation-prompts.js";
import {
  generationRecordForHandoff,
  reasoningForHandoff,
  type GenerationRecordHandoff
} from "./generation-record-handoff.js";
import type { SettingsStore } from "./settings.js";
import { commitTake, createEditedTake } from "./story-nodes.js";
import type { StoryStore } from "./stories.js";

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
  const rawText = body.text;
  if (rawText.trim().length === 0) throw new ServiceError(400, "Nothing to save");
  const genId = body.genId ?? null;
  const providedInstruction = body.instruction ?? "";
  const instruction = genId === null ? providedInstruction : providedInstruction.trim() || DEFAULT_INSTRUCTION;

  return await stories.withLock(id, async () => {
    const story = await stories.loadForMutation(id);
    // Everything below runs once, under this genId's handoff lease when
    // there is one (a human take has no genId, so nothing to lease) — the
    // registry releases the handoff only once this resolves, and retains it
    // if anything here throws.
    const commitWithHandoff = async (handoff: GenerationRecordHandoff | undefined): Promise<void> => {
      if (mutationNodeId !== undefined && story.nodes.some((node) => node.id === mutationNodeId)) {
        // A retried commit for a mutationNodeId already saved: nothing left
        // to do, and resolving here still releases the lease above exactly
        // as a fresh commit would.
        return;
      }
      if (body.sourceNodeId !== undefined) {
        await stories.hydratePath(story, body.sourceNodeId);
        createEditedTake(
          story,
          body.sourceNodeId,
          body.expectedTextHash,
          instruction,
          rawText.trim(),
          mutationNodeId
        );
        await stories.save(story);
        return;
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
      const text = appendTo === null ? rawText.trim() : rawText;
      // A stop-and-save commit for a generated take: whatever the streaming
      // request that produced this text captured before it stopped, keyed by
      // the same genId. Absent for a human take, a duplicate settle (dedup
      // above returns before this runs), or a genId this process never saw
      // stream anything.
      const generationRecord = generationRecordForHandoff(handoff, appendTo, text, new Date().toISOString());
      const reasoning = reasoningForHandoff(handoff, appendTo, text);
      const { duplicate } = commitTake(story, {
        parentId: appendCrossesBreak ? requestedAppendTo : appendTo === null ? parentId : null,
        appendTo,
        expectedTextHash,
        instruction,
        text,
        model,
        genId,
        generationRecord,
        reasoning,
        ...(mutationNodeId === undefined ? {} : { nodeId: mutationNodeId })
      });
      if (!duplicate) await stories.save(story);
    };
    if (genId === null) {
      await commitWithHandoff(undefined);
    } else {
      await generationAdmission.withGenerationRecordHandoff(id, genId, commitWithHandoff);
    }
    return story;
  });
}
