import { activePath, descendantLine } from "../shared/story-tree.js";
import { activeLineFingerprintSource } from "../shared/story-text.js";
import type { Story, StoryPayload } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import { currentModel } from "./generation-http.js";
import { DEFAULT_INSTRUCTION } from "./generation-prompts.js";
import type { GenerationAdmissionRegistry } from "./generation-admission.js";
import {
  generationRecordForHandoff,
  reasoningForHandoff,
  type GenerationRecordHandoff
} from "./generation-record-handoff.js";
import { commitNode } from "./node-commit.js";
import {
  parseCommitPartialRewrite,
  parseCreateNode,
  parseEditNode,
  parsePasteStoryLine,
  parsePruneUnusedTakes,
  parseSwitchOptions,
  parseTakeFromCut
} from "./service-input.js";
import type { PartialRewriteStash } from "./rewrite-partial.js";
import { applyProviderStoryEffect } from "./story-provider-effect.js";
import type { SettingsStore } from "./settings.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import { putStoryTag, removeStoryTag } from "./story-tags.js";
import { createFacts, deleteFact, patchFact, reorderFact } from "./story-facts.js";
import { authorsNoteApplied, setAuthorsNote } from "./story-authors-note.js";
import { authorBriefApplied, setAuthorBrief } from "./story-author-brief.js";
import { setFactsBudget } from "./story-facts-budget.js";
import { bannedStringsApplied, phraseBiasApplied, setBannedStrings, setPhraseBias } from "./story-sampling.js";
import type { SamplingPhraseBiasEntryV2 } from "../shared/settings-v2-types.js";
import { HASH_PATTERN, sha256 } from "./story-format.js";
import type {
  LocalStoryMutationMethod,
  StoryMutationStore
} from "./story-mutation-store.js";
import { isPreparedDomainError } from "./mutation-ledger-types.js";
import {
  applyHumanEdit,
  assertStoryLineCopySize,
  commitTake,
  createEditedTake,
  createTakeFromCut,
  deleteSubtree,
  pasteStoryLine as pasteStoryLineNodes,
  type PasteStoryLineIds,
  pruneUnusedTakes as pruneUnusedStoryTakes,
  switchLine as switchTreeLine
} from "./story-nodes.js";
import { buildStoryPayload } from "./story-payload.js";
import { STORY_UNCHANGED, type StoryStore } from "./stories.js";
import { asideEntryPointsOpen } from "../shared/aside-release.js";
import { clearPendingAsideDocument } from "./story-aside-pending.js";
import {
  mintActivatedStoryMutationRequest,
  mintStoryMutationRequest
} from "./story-mutation-request.js";

export interface StoryServiceLocalDependencies {
  readonly stories: StoryStore;
  readonly settings: SettingsStore;
  readonly generationAdmission: GenerationAdmissionRegistry;
  readonly rewritePartials: PartialRewriteStash;
  readonly storyMutations: StoryMutationStore;
  readonly dataFormat: () => number;
  readonly ensureOpen: () => void;
}

const PARTIAL_REWRITE_UNAVAILABLE = Symbol("partial rewrite unavailable");

/** Direct-author story commands, including their successor-Q adapters. */
export class StoryServiceLocal {
  constructor(private readonly dependencies: StoryServiceLocalDependencies) {}

  async renameStory(
    id: string,
    title: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    const normalized = title.trim();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(
        this.dependencies.stories,
        id,
        "renameStory",
        normalized
      );
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "renameStory",
        (story) => {
          if (story.title === normalized) return STORY_UNCHANGED;
          story.title = normalized;
        }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => { story.title = normalized; }
    ));
  }

  async setAuthorsNote(
    id: string,
    note: string,
    depth?: number,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "setAuthorsNote", note);
    }
    if (this.dependencies.dataFormat() < 4) {
      throw new ServiceError(
        409,
        "Setting an Author's Note requires a project on data format 4; this directory is not upgraded.",
        "data_directory_version_unsupported"
      );
    }
    const normalized = note.trim().length === 0 ? "" : note;
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "setAuthorsNote",
        (story) => {
          if (authorsNoteApplied(story, normalized, depth)) return STORY_UNCHANGED;
          setAuthorsNote(story, normalized, depth);
        }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => { setAuthorsNote(story, normalized, depth); }
    ));
  }

  async setAuthorBrief(
    id: string,
    brief: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "setAuthorBrief", brief);
    }
    if (this.dependencies.dataFormat() < 4) {
      throw new ServiceError(
        409,
        "Setting an Author Brief requires a project on data format 4; this directory is not upgraded.",
        "data_directory_version_unsupported"
      );
    }
    const normalized = brief.trim().length === 0 ? "" : brief;
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "setAuthorBrief",
        (story) => {
          if (authorBriefApplied(story, normalized)) return STORY_UNCHANGED;
          setAuthorBrief(story, normalized);
        }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => { setAuthorBrief(story, normalized); }
    ));
  }

  async setFactsBudget(
    id: string,
    budgetTokens: number | null,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "setFactsBudget", String(budgetTokens));
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "setFactsBudget",
        (story) => {
          if ((story.factsBudgetTokens ?? null) === budgetTokens) return STORY_UNCHANGED;
          setFactsBudget(story, budgetTokens);
        }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => { setFactsBudget(story, budgetTokens); }
    ));
  }

  async setPhraseBias(
    id: string,
    phraseBias: readonly SamplingPhraseBiasEntryV2[],
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "setPhraseBias", JSON.stringify(phraseBias));
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "setPhraseBias",
        (story) => {
          if (phraseBiasApplied(story, phraseBias)) return STORY_UNCHANGED;
          setPhraseBias(story, phraseBias);
        }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => { setPhraseBias(story, phraseBias); }
    ));
  }

  async setBannedStrings(
    id: string,
    bannedStrings: readonly string[],
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "setBannedStrings", JSON.stringify(bannedStrings));
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "setBannedStrings",
        (story) => {
          if (bannedStringsApplied(story, bannedStrings)) return STORY_UNCHANGED;
          setBannedStrings(story, bannedStrings);
        }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => { setBannedStrings(story, bannedStrings); }
    ));
  }

  async switchLine(
    id: string,
    nodeId: string,
    value: unknown = {},
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "switchLine", nodeId);
    }
    const options = parseSwitchOptions(value);
    if (options.expectedLineFingerprint !== undefined
      && !HASH_PATTERN.test(options.expectedLineFingerprint)) {
      throw new ServiceError(400, "Invalid expected line fingerprint");
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "switchLine",
        (story) => {
          if (options.expectedLineFingerprint !== undefined
            && sha256(activeLineFingerprintSource(story.title, activePath(story)))
              !== options.expectedLineFingerprint) return STORY_UNCHANGED;
          return switchTreeLine(story, nodeId, options)
            ? undefined
            : STORY_UNCHANGED;
        }
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.switchLine(id, nodeId, options)
    );
  }

  async createNode(
    id: string,
    value: unknown,
    nodeId?: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "createNode", nodeId ?? "");
    }
    const body = parseCreateNode(value);
    if (mutationRequest !== undefined) {
      const rawText = body.text;
      if (rawText.trim().length === 0) {
        throw new ServiceError(400, "Nothing to save");
      }
      const genId = body.genId ?? null;
      const providedInstruction = body.instruction ?? "";
      const instruction = genId === null
        ? providedInstruction
        : providedInstruction.trim() || DEFAULT_INSTRUCTION;
      const model = genId === null
        ? "human"
        : this.dependencies.generationAdmission.modelFor(id, genId)
          ?? await currentModel(this.dependencies.settings);
      // Everything below runs once, under this genId's handoff lease when
      // there is one (a human take has no genId, so nothing to lease) — the
      // registry releases the handoff only once this resolves, and retains
      // it if anything here throws.
      const commitWithHandoff = (handoff: GenerationRecordHandoff | undefined): Promise<StoryPayload> =>
        this.localStoryPayload(
          mutationRequest,
          "createNode",
          async (story, session) => {
            if (nodeId !== undefined
              && story.nodes.some((node) => node.id === nodeId)) {
              return STORY_UNCHANGED;
            }
            if (body.sourceNodeId !== undefined) {
              await session.hydratePath(story, body.sourceNodeId);
              createEditedTake(
                story,
                body.sourceNodeId,
                body.expectedTextHash,
                instruction,
                rawText.trim(),
                nodeId
              );
              return;
            }
            const requestedAppendTo = body.appendTo ?? null;
            const appendCrossesBreak = requestedAppendTo !== null
              && story.chapterBreaks.some(
                (chapterBreak) => chapterBreak.parentPartId === requestedAppendTo
              );
            const appendTo = appendCrossesBreak ? null : requestedAppendTo;
            if (appendTo !== null) await session.hydratePath(story, appendTo);
            const text = appendTo === null ? rawText.trim() : rawText;
            // A stop-and-save commit for a generated take: see the identical
            // handoff read in server/node-commit.ts. `appendTo` is resolved
            // above from the current story, not the one the original streaming
            // request saw, so the record's kind and range always follow this
            // commit's own decision.
            const generationRecord = generationRecordForHandoff(handoff, appendTo, text, new Date().toISOString());
            const reasoning = reasoningForHandoff(handoff, appendTo, text);
            const commit = commitTake(story, {
              parentId: appendCrossesBreak
                ? requestedAppendTo
                : appendTo === null ? body.parentId ?? null : null,
              appendTo,
              expectedTextHash: appendTo !== null && body.appendTo !== undefined
                ? body.expectedTextHash
                : null,
              instruction,
              text,
              model,
              genId,
              generationRecord,
              reasoning,
              ...(nodeId === undefined ? {} : { nodeId })
            });
            return commit.duplicate ? STORY_UNCHANGED : undefined;
          }
        );
      return genId === null
        ? await commitWithHandoff(undefined)
        : await this.dependencies.generationAdmission.withGenerationRecordHandoff(id, genId, commitWithHandoff);
    }
    return buildStoryPayload(await commitNode(
      this.dependencies.stories,
      this.dependencies.settings,
      this.dependencies.generationAdmission,
      id,
      body,
      nodeId
    ));
  }

  /**
   * The canonical partial-rewrite commit (issue #339): settle the verified
   * partial a stopped or timed-out rewrite stashed, splicing it into the
   * original selected range through the same rewrite effect a full commit
   * uses — expected-text revalidation, rewritten spans, destination
   * current-take/new-take semantics, and the original attempt's
   * rewriteId/takeId replay markers included. Returns null when nothing was
   * stashed for this part or the presented digest does not match;
   * null commits nothing, so the caller reports nothing saved.
   */
  async commitPartialRewrite(
    id: string,
    nodeId: string,
    value: unknown,
    mutationRequest?: unknown,
    settleTakeId?: string
  ): Promise<{ payload: StoryPayload; nodeId: string } | null> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "commitPartialRewrite", nodeId);
    }
    const body = parseCommitPartialRewrite(value);
    const claimedRecord = await this.dependencies.rewritePartials.claim(
      id,
      nodeId,
      body.attemptId
    );
    const record = claimedRecord?.streamedDigest === body.streamedDigest
      ? claimedRecord
      : null;
    if (claimedRecord !== null && record === null) {
      this.dependencies.rewritePartials.releaseClaim(claimedRecord);
    }
    if (mutationRequest !== undefined) {
      const settlementId = mutationRequestId(mutationRequest);
      let consumedRecord = false;
      try {
        const committed = await this.dependencies.storyMutations.runLocal(
          mutationRequest,
          "commitPartialRewrite",
          async (story, session) => {
            // This callback does not run for a durable replay. A fresh settle
            // without the exact volatile record refuses without creating a
            // receipt; a replay after process restart still returns the
            // already-committed story from the ledger.
            if (record === null
              || record.streamedDigest !== body.streamedDigest
              || settlementId === null
              || !this.dependencies.rewritePartials.bindSettlement(
                record,
                settlementId
              )) {
              throw PARTIAL_REWRITE_UNAVAILABLE;
            }
            const effect = {
              ...record.effect,
              ...(record.effect.destination === "take"
                && settleTakeId !== undefined
                ? { takeId: settleTakeId }
                : {}),
              updatedAt: new Date().toISOString()
            };
            const applied = await applyProviderStoryEffect(
              story,
              effect,
              async (current, pathNodeId) => {
                await session.hydratePath(current, pathNodeId);
              }
            );
            consumedRecord = true;
            return applied.changed ? undefined : STORY_UNCHANGED;
          }
        );
        if (record !== null) {
          if (consumedRecord
            || (settlementId !== null
              && this.dependencies.rewritePartials.settlementMatches(
                record,
                settlementId
              ))) {
            this.dependencies.rewritePartials.clear(record);
          }
          else this.dependencies.rewritePartials.releaseClaim(record);
        }
        const committedNodeId = settleTakeId !== undefined
          && committed.story.nodes.some((node) => node.id === settleTakeId)
          ? settleTakeId
          : nodeId;
        return {
          payload: buildStoryPayload(committed.story, {
            ...committed.aggregateVersion
          }),
          nodeId: committedNodeId
        };
      } catch (error) {
        if (error === PARTIAL_REWRITE_UNAVAILABLE) {
          if (record !== null) {
            this.dependencies.rewritePartials.releaseClaim(record);
          }
          return null;
        }
        // runLocal returns a prepared domain error only after its terminal
        // receipt is durable. Retire only the record that the callback bound
        // to this settlement. A terminal replay can claim a newer record with
        // the same attempt and digest without running that callback.
        if (record !== null
          && error instanceof ServiceError
          && isPreparedDomainError(error.code)
          && settlementId !== null
          && this.dependencies.rewritePartials.settlementMatches(
            record,
            settlementId
          )) {
          this.dependencies.rewritePartials.clear(record);
        } else if (record !== null) {
          this.dependencies.rewritePartials.releaseClaim(record);
        }
        throw error;
      }
    }
    if (record === null) return null;
    const effect = {
      ...record.effect,
      updatedAt: new Date().toISOString()
    };
    try {
      const node = await this.dependencies.stories.commitProviderEffect(
        id,
        effect
      );
      this.dependencies.rewritePartials.clear(record);
      return {
        payload: buildStoryPayload(
          await this.dependencies.stories.loadForMutation(id)
        ),
        nodeId: node.id
      };
    } catch (error) {
      this.dependencies.rewritePartials.releaseClaim(record);
      throw error;
    }
  }

  async editNode(
    id: string,
    nodeId: string,
    value: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "editNode", nodeId);
    }
    const edit = parseEditNode(value);
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "editNode",
        async (story, session) => {
          await session.hydratePath(story, nodeId);
          const node = story.nodes.find((candidate) => candidate.id === nodeId);
          const unchanged = node !== undefined
            && (edit.text === undefined || edit.text === node.text)
            && (edit.instruction === undefined
              || edit.instruction === node.instruction);
          applyHumanEdit(story, nodeId, edit);
          return unchanged ? STORY_UNCHANGED : undefined;
        }
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.editNode(id, nodeId, edit)
    );
  }

  async deleteNode(
    id: string,
    nodeId: string,
    expectedSubtreeCount: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "deleteNode", nodeId);
    }
    if (typeof expectedSubtreeCount !== "number"
      || !Number.isSafeInteger(expectedSubtreeCount)) {
      throw new ServiceError(400, "expectedSubtreeCount must be an integer");
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "deleteNode",
        (story) => { deleteSubtree(story, nodeId, expectedSubtreeCount); }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.deleteNode(
      id,
      nodeId,
      expectedSubtreeCount
    ));
  }

  async pruneUnusedTakes(
    id: string,
    value: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "pruneUnusedTakes", JSON.stringify(value));
    }
    const expected = parsePruneUnusedTakes(value);
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "pruneUnusedTakes",
        (story) => pruneUnusedStoryTakes(story, expected) === 0
          ? STORY_UNCHANGED
          : undefined
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.pruneUnusedTakes(id, expected)
    );
  }

  async takeFromCut(
    id: string,
    nodeId: string,
    value: unknown,
    takeId?: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "takeFromCut", nodeId);
    }
    const body = parseTakeFromCut(value);
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "takeFromCut",
        async (story, session) => {
          if (takeId !== undefined
            && story.nodes.some((node) => node.id === takeId)) {
            return STORY_UNCHANGED;
          }
          await session.hydratePath(story, nodeId);
          createTakeFromCut(
            story,
            nodeId,
            body.offset,
            body.expected ?? null,
            takeId
          );
        }
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.createTakeFromCut(
        id,
        nodeId,
        body.offset,
        body.expected ?? null,
        takeId
      )
    );
  }

  async pasteStoryLine(
    id: string,
    targetParentId: string,
    value: unknown,
    ids: PasteStoryLineIds = {},
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "pasteStoryLine", targetParentId);
    }
    const body = parsePasteStoryLine(value);
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "pasteStoryLine",
        async (story, session) => {
          const firstCloneId = ids.nodeId?.(0);
          if (firstCloneId !== undefined && story.nodes.some((node) => node.id === firstCloneId)) {
            return STORY_UNCHANGED;
          }
          // The nodes to clone are the source's descendants, not its
          // ancestors — hydrate the chain itself, not `hydratePath`'s
          // root-to-node ancestry.
          const sourceLine = descendantLine(story, body.sourceNodeId);
          assertStoryLineCopySize(sourceLine.length);
          await session.hydrateNodes(story, sourceLine.map((node) => node.id));
          pasteStoryLineNodes(story, body.sourceNodeId, targetParentId, body.expectedLeafId, ids);
        }
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.pasteStoryLine(id, targetParentId, body, ids)
    );
  }

  async putBookmark(
    id: string,
    nodeId: string,
    name: string,
    label: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "putBookmark", nodeId);
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "putBookmark",
        (story) => {
          const existing = story.tags.find(
            (tag) => tag.nodeId === nodeId
          );
          const unchanged = existing?.name === name
            && existing.status === label
            && (label !== "Canon" || story.tags.every(
              (tag) => tag.nodeId === nodeId
                || tag.status !== "Canon"
            ));
          putStoryTag(story, nodeId, name, label);
          return unchanged ? STORY_UNCHANGED : undefined;
        }
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.setTag(id, nodeId, name, label)
    );
  }

  async deleteBookmark(
    id: string,
    nodeId: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "deleteBookmark", nodeId);
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "deleteBookmark",
        (story) => { removeStoryTag(story, nodeId); }
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.deleteBookmark(id, nodeId)
    );
  }

  async createFact(
    id: string,
    body: unknown,
    factId?: (index: number) => string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "createFact", JSON.stringify(body));
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "createFact",
        (story) => {
          return createFacts(
            story,
            body,
            (index) => factId?.(index) ?? crypto.randomUUID()
          ) ? undefined : STORY_UNCHANGED;
        }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => createFacts(
        story,
        body,
        (index) => factId?.(index) ?? crypto.randomUUID()
      )
        ? undefined
        : STORY_UNCHANGED
    ));
  }

  /**
   * `createFact` for a batch whose content is planned from the story it
   * mutates. The planner runs inside the canonical mutation callback, so the
   * room it reads is exactly the room the commit consumes, and the report it
   * returns is exactly the account of what this mutation did.
   *
   * When the ledger answers a retry from durable evidence, the callback never
   * runs, and the report comes from `replay` — the plan a prior attempt
   * preserved. A receipt that committed before plans were preserved has no
   * faithful report to give; that replay refuses instead of recomputing one
   * from the changed story.
   */
  async createPlannedFacts<Report>(
    id: string,
    mutationRequest: unknown,
    plan: {
      planned: (story: Story) => Promise<Report>;
      body: (report: Report) => unknown;
      replay: () => Report | null;
    }
  ): Promise<{ payload: StoryPayload; report: Report }> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "createFact");
    }
    let produced: Report | null = null;
    const mutate = async (story: Story) => {
      const report = await plan.planned(story);
      produced = report;
      return createFacts(story, plan.body(report)) ? undefined : STORY_UNCHANGED;
    };
    if (mutationRequest !== undefined) {
      const committed = await this.dependencies.storyMutations.runLocal(
        mutationRequest,
        "createFact",
        mutate
      );
      const report = produced ?? plan.replay();
      if (report === null) {
        throw new ServiceError(
          409,
          "A retained import replay has no preserved import plan; reload the story to see the imported Facts.",
          "mutation_outcome_unknown"
        );
      }
      return {
        payload: buildStoryPayload(committed.story, {
          ...committed.aggregateVersion
        }),
        report
      };
    }
    const story = await this.dependencies.stories.mutate(id, mutate);
    if (produced === null) {
      throw new ServiceError(500, "A fact import lost its plan", "internal");
    }
    return { payload: buildStoryPayload(story), report: produced };
  }

  async patchFact(
    id: string,
    factId: string,
    body: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "patchFact", factId);
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "patchFact",
        (story) => { patchFact(story, factId, body); }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => patchFact(story, factId, body)
    ));
  }

  async deleteFact(
    id: string,
    factId: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "deleteFact", factId);
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "deleteFact",
        (story) => { deleteFact(story, factId); }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => deleteFact(story, factId)
    ));
  }

  async reorderFact(
    id: string,
    factId: string,
    body: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "reorderFact", factId);
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "reorderFact",
        (story) => { reorderFact(story, factId, body); }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => reorderFact(story, factId, body)
    ));
  }

  /**
   * Clear every Side Note for one story. Returns resource_busy while any
   * provider request for the story is unresolved, so an in-flight answer
   * cannot reappear after a successful clear.
   */
  async clearAside(
    id: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest === undefined) {
      mutationRequest = await mintActivatedStoryMutationRequest(this.dependencies.stories, id, "clearAside");
    }
    if (!asideEntryPointsOpen(this.dependencies.stories.asideActivation)
      && mutationRequest === undefined) {
      throw new ServiceError(400, "Aside is not available in this release.", "aside_not_supported");
    }
    const clear = (story: Story, session?: StoryAggregateSession): void | typeof STORY_UNCHANGED => {
      if (session !== undefined && session.snapshot.manifest.unresolvedProvider !== null) {
        throw new ServiceError(
          409,
          "A model request for this story is still unresolved. Wait for it to finish before clearing Aside.",
          "resource_busy"
        );
      }
      if (story.asideDocumentId === null) {
        // A repeated clear is already represented by the durable tombstone.
        return STORY_UNCHANGED;
      }
      // A first clear must write the nullable V9 field. It fences an Aside
      // answer admitted while the story still had no Aside state.
      clearPendingAsideDocument(story);
      story.asideDocumentId = null;
    };
    // Clear writes V9/V10 (null asideDocumentId) through the aggregate session.
    // Mint a durable request when the transport did not supply one.
    const request = mutationRequest === undefined
      ? await mintStoryMutationRequest(
          this.dependencies.stories,
          id,
          "clearAside"
        )
      : mutationRequest;
    return await this.localStoryPayload(
      request,
      "clearAside",
      (story, session) => clear(story, session)
    );
  }

  private async localStoryPayload(
    mutationRequest: unknown,
    method: LocalStoryMutationMethod,
    mutate: (
      story: Story,
      session: StoryAggregateSession
    ) => void | typeof STORY_UNCHANGED
      | Promise<void | typeof STORY_UNCHANGED>
  ): Promise<StoryPayload> {
    const committed = await this.dependencies.storyMutations.runLocal(
      mutationRequest,
      method,
      mutate
    );
    return buildStoryPayload(committed.story, {
      ...committed.aggregateVersion
    });
  }
}

function mutationRequestId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const mutationId = (value as { readonly mutationId?: unknown }).mutationId;
  return typeof mutationId === "string" ? mutationId : null;
}
