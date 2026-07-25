import { activePath, switchToNode } from "../../shared/story-tree.js";
import type { Story, StoryNode } from "../../shared/types.js";
import { attributionAfterHumanEdit } from "../../shared/human-edit.js";
import { makeDemoNode } from "./demo-fixture.js";

/** Mutate the in-memory demo with the same sibling and endpoint-bookmark
 * behavior as the backend. Source metadata is copied only for edit-as-sibling. */
export function createDemoTake(
  story: Story,
  parentId: string | null,
  instruction: string,
  text: string,
  human: boolean,
  source: StoryNode | null = null
): void {
  if (parentId !== null && !story.nodes.some((node) => node.id === parentId)) {
    throw new Error(`Unknown demo node: ${parentId}`);
  }
  const endpointBookmark = parentId !== null && activePath(story).at(-1)?.id === parentId
    ? story.bookmarks.find((bookmark) => bookmark.nodeId === parentId)
    : undefined;
  const id = `demo-take-${story.nodes.length + 1}`;
  const node = makeDemoNode(id, parentId, instruction, text, source === null ? undefined : {
    model: source.model,
    ...(source.role === undefined ? {} : { role: source.role }),
    ...(source.coveredExtent === undefined ? {} : { coveredExtent: { ...source.coveredExtent } }),
    ...(source.madeAt === undefined ? {} : { madeAt: source.madeAt }),
    attribution: text === source.text
      ? cloneAttribution(source)
      : attributionAfterHumanEdit(source.attribution, source.text, text)
  });
  if (human) node.human = true;
  story.nodes.push(node);
  if (endpointBookmark !== undefined) endpointBookmark.nodeId = id;
  switchToNode(story, id, { stopAtNode: true });
}

function cloneAttribution(source: StoryNode): StoryNode["attribution"] {
  return source.attribution == null
    ? source.attribution
    : { ...source.attribution, ranges: source.attribution.ranges.map((range) => ({ ...range })) };
}
