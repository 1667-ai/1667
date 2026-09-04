import type { AsideAnchor } from "../shared/aside-session.js";
import type { AsideSessionRef } from "../shared/aside-session-index.js";
import {
  parseManifestV13,
  parseManifestV15,
  serializeManifestContent,
  type StoryManifestV13,
  type StoryManifestV15
} from "./story-format.js";
import { formatV14, formatV16, STORY_SCHEMA_VERSION_V14 } from "./story-v6-codec.js";
import type { LiveStoryManifestV14 } from "./story-v14-types.js";
import type { LiveStoryManifestV16 } from "./story-v16-types.js";
import { MAX_STORY_MANIFEST_BYTES } from "./story-v5-strict.js";
import { ServiceError as HttpError } from "./errors.js";
import type { StoryEnvelopeManifest } from "./story-v6-types.js";

type AsideContent = StoryManifestV13 | StoryManifestV15;
type AsideEnvelope = LiveStoryManifestV14 | LiveStoryManifestV16;

interface AsideManifestProjection<
  Content extends AsideContent,
  Envelope extends AsideEnvelope
> {
  readonly content: (manifest: Envelope) => Content;
  readonly projectContent: (
    source: Content,
    anchoredRefs: AsideSessionRef[],
    unanchoredRefs: AsideSessionRef[]
  ) => Content;
  readonly projectEnvelope: (
    source: Envelope,
    content: Content,
    mutationId: string | undefined
  ) => Envelope;
  readonly format: (manifest: Envelope) => string;
  readonly parseContent: (raw: string, storyId: string) => unknown;
}

/** Check one V14 or V16 Aside projection. The schema-specific callbacks keep
 * the workflow shared while each version retains its own parser and codec. */
export function assertVersionedAsideSessionManifestFits(
  manifest: StoryEnvelopeManifest | undefined,
  mutationId: string | undefined,
  sessionId: string,
  anchor: AsideAnchor | null,
  sourceAsideDocumentId?: string,
  turnCount = 1,
  projectedRef?: AsideSessionRef
): void {
  if (manifest === undefined || manifest.kind !== "live") return;
  if (manifest.schemaVersion === 16) {
    assertProjection<StoryManifestV15, LiveStoryManifestV16>(
      manifest,
      mutationId,
      sessionId,
      anchor,
      sourceAsideDocumentId,
      turnCount,
      projectedRef,
      {
        content: (value) => value.content,
        projectContent: (source, anchoredRefs, unanchoredRefs) => ({
          ...source,
          schemaVersion: 15,
          asideSessionRefs: anchoredRefs,
          asideUnanchoredSessionRefs: unanchoredRefs
        }),
        projectEnvelope: (source, content, nextMutationId) => nextMutationId === undefined
          ? { ...source, schemaVersion: 16, content }
          : {
              ...source,
              schemaVersion: 16,
              revision: nextRevision(source.revision),
              previousManifestHash: "0".repeat(64),
              unresolvedProvider: null,
              lastTransaction: {
                receiptKind: "user" as const,
                mutationId: nextMutationId,
                phase: "prepared" as const
              },
              content
            },
        format: formatV16,
        parseContent: parseManifestV15
      }
    );
    return;
  }
  if (manifest.schemaVersion === STORY_SCHEMA_VERSION_V14) {
    assertProjection<StoryManifestV13, LiveStoryManifestV14>(
      manifest,
      mutationId,
      sessionId,
      anchor,
      sourceAsideDocumentId,
      turnCount,
      projectedRef,
      {
        content: (value) => value.content,
        projectContent: (source, anchoredRefs, unanchoredRefs) => ({
          ...source,
          schemaVersion: 13,
          asideSessionRefs: anchoredRefs,
          asideUnanchoredSessionRefs: unanchoredRefs
        }),
        projectEnvelope: (source, content, nextMutationId) => nextMutationId === undefined
          ? { ...source, schemaVersion: STORY_SCHEMA_VERSION_V14, content }
          : {
              ...source,
              schemaVersion: STORY_SCHEMA_VERSION_V14,
              revision: nextRevision(source.revision),
              previousManifestHash: "0".repeat(64),
              unresolvedProvider: null,
              lastTransaction: {
                receiptKind: "user" as const,
                mutationId: nextMutationId,
                phase: "prepared" as const
              },
              content
            },
        format: formatV14,
        parseContent: parseManifestV13
      }
    );
  }
}

function assertProjection<
  Content extends AsideContent,
  Envelope extends AsideEnvelope
>(
  manifest: Envelope,
  mutationId: string | undefined,
  sessionId: string,
  anchor: AsideAnchor | null,
  sourceAsideDocumentId: string | undefined,
  turnCount: number,
  projectedRef: AsideSessionRef | undefined,
  projection: AsideManifestProjection<Content, Envelope>
): void {
  const source = projection.content(manifest);
  const placeholder = projectedRef ?? {
    id: sessionId,
    documentId: "0".repeat(64),
    anchor: anchor === null ? null : { ...anchor },
    ...(sourceAsideDocumentId === undefined ? {} : { sourceAsideDocumentId }),
    turnCount
  };
  const nextAnchoredRefs = source.asideSessionRefs.filter((ref) => ref.id !== sessionId);
  const nextUnanchoredRefs = source.asideUnanchoredSessionRefs.filter((ref) => ref.id !== sessionId);
  if (placeholder.anchor === null) nextUnanchoredRefs.push(placeholder);
  else nextAnchoredRefs.push(placeholder);

  const content = projection.projectContent(source, nextAnchoredRefs, nextUnanchoredRefs);
  const contentText = serializeManifestContent(content);
  if (Buffer.byteLength(contentText, "utf8") > MAX_STORY_MANIFEST_BYTES) {
    throw tooLargeAsideManifest();
  }

  let envelopeText: string;
  try {
    envelopeText = projection.format(projection.projectEnvelope(manifest, content, mutationId));
  } catch (error) {
    if (error instanceof Error && /manifest exceeds.*size limit|manifest replacement exceeds/u.test(error.message)) {
      throw tooLargeAsideManifest();
    }
    throw error;
  }
  if (Buffer.byteLength(envelopeText, "utf8") > MAX_STORY_MANIFEST_BYTES) {
    throw tooLargeAsideManifest();
  }
  projection.parseContent(contentText, manifest.id);
}

function tooLargeAsideManifest(): HttpError {
  return new HttpError(
    422,
    "This story manifest cannot hold another Aside session.",
    "content_too_large"
  );
}

function nextRevision(revision: string): string {
  return (BigInt(revision) + 1n).toString().padStart(20, "0");
}
