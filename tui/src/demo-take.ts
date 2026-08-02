import { activePath, switchToNode } from "../../shared/story-tree.js";
import type { Story, StoryNode } from "../../shared/types.js";
import { attributionAfterHumanEdit } from "../../shared/human-edit.js";
import { makeDemoNode } from "./demo-fixture.js";

/** Optional fields `createDemoTake` needs for only some callers, collapsed
 *  into one object rather than positional params three call sites would
 *  otherwise thread by position (and skip past with `undefined`) for
 *  subsets they don't need. */
export interface CreateDemoTakeOptions {
  /** Source node metadata to copy — edit-as-sibling and rewrite only. */
  readonly source?: StoryNode | null;
  /** Provider commits pass this; human and edit-as-sibling takes omit it. */
  readonly genId?: string;
  /** Replaces the default human-edit attribution derivation when given — the
   *  rewrite path needs the model-replacement shape
   *  `attributionAfterReplacement` computes, never the human-edit one. */
  readonly attributionOverride?: StoryNode["attribution"];
}

/** Mutate the in-memory demo with the same sibling and endpoint-tag
 * behavior as the backend. */
export function createDemoTake(
  story: Story,
  parentId: string | null,
  instruction: string,
  text: string,
  human: boolean,
  options: CreateDemoTakeOptions = {}
): StoryNode {
  const { source = null, genId, attributionOverride } = options;
  if (parentId !== null && !story.nodes.some((node) => node.id === parentId)) {
    throw new Error(`Unknown demo node: ${parentId}`);
  }
  const endpointTag = parentId !== null && activePath(story).at(-1)?.id === parentId
    ? story.tags.find((tag) => tag.nodeId === parentId)
    : undefined;
  const id = `demo-take-${story.nodes.length + 1}`;
  const node = makeDemoNode(id, parentId, instruction, text, source === null ? undefined : {
    model: source.model,
    ...(source.role === undefined ? {} : { role: source.role }),
    ...(source.coveredExtent === undefined ? {} : { coveredExtent: { ...source.coveredExtent } }),
    ...(source.madeAt === undefined ? {} : { madeAt: source.madeAt }),
    attribution: attributionOverride !== undefined
      ? attributionOverride
      : text === source.text
        ? cloneAttribution(source)
        : attributionAfterHumanEdit(source.attribution, source.text, text)
  });
  if (human) node.human = true;
  if (genId !== undefined) node.genId = genId;
  story.nodes.push(node);
  if (endpointTag !== undefined) endpointTag.nodeId = id;
  switchToNode(story, id, { stopAtNode: true });
  return node;
}

function cloneAttribution(source: StoryNode): StoryNode["attribution"] {
  return source.attribution == null
    ? source.attribution
    : { ...source.attribution, ranges: source.attribution.ranges.map((range) => ({ ...range })) };
}
