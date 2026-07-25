import { countWords } from "../../shared/story-text.js";
import { nodeStubHasInstruction, nodeStubPreviewText } from "../../shared/node-stub.js";
import type { NodeStub, StoryNode, StoryPayload } from "../../shared/types.js";

/** Mutation responses carry node stubs for off-path siblings, not a separate
 * created ID. Match the canonical wire projection without assuming reroute. */
export function findCreatedTake(
  payload: StoryPayload,
  knownNodeIds: ReadonlySet<string>,
  parentId: string | null,
  instruction: string,
  text: string
): StoryNode | undefined {
  const active = payload.path.find((node) =>
    !knownNodeIds.has(node.id)
    && node.parentId === parentId
    && node.instruction === instruction
    && node.text === text
  );
  if (active !== undefined) return active;
  const stub = payload.nodes.filter((node) =>
    !knownNodeIds.has(node.id)
    && node.parentId === parentId
    && matchesCreatedTake(node, instruction, text)
  ).at(-1);
  if (stub === undefined) return undefined;
  return {
    id: stub.id,
    parentId,
    instruction,
    text,
    model: "human",
    createdAt: stub.lastTouched,
    activeChildId: stub.activeChildId,
    ...(stub.human === true ? { human: true as const } : {})
  };
}

function matchesCreatedTake(stub: NodeStub, instruction: string, text: string): boolean {
  return stub.preview === nodeStubPreviewText(text)
    && stub.words === countWords(text)
    && stub.hasInstruction === nodeStubHasInstruction(instruction);
}
