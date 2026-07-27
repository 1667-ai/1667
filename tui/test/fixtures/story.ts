import type { StoryNode, StoryPayload } from "../../../shared/types.js";

/** Deterministic active line for wrapping and frame-runtime stress tests. */
export function syntheticStoryPayload(
  parts: number,
  wordsPerPart: number,
  prefix = "p"
): StoryPayload {
  const nodes: StoryPayload["nodes"] = [];
  const path: StoryNode[] = [];
  let parentId: string | null = null;
  const words = ["lantern", "weather", "crossed", "the", "quiet", "room"];
  const text = Array.from({ length: wordsPerPart }, (_, index) => words[index % words.length]).join(" ");
  for (let index = 0; index < parts; index += 1) {
    const id = `${prefix}${index}`;
    const activeChildId = index + 1 < parts ? `${prefix}${index + 1}` : null;
    nodes.push({
      id,
      parentId,
      preview: text.slice(0, 100),
      words: wordsPerPart,
      tokens: wordsPerPart * 2,
      childCount: activeChildId === null ? 0 : 1,
      leafCount: 1,
      lastTouched: "2026-07-20T00:00:00Z",
      hasInstruction: false,
      activeChildId
    });
    path.push({
      id,
      parentId,
      instruction: "",
      text,
      model: "test",
      createdAt: "2026-07-20T00:00:00Z",
      activeChildId
    });
    parentId = id;
  }
  return {
    id: `${prefix}-story`,
    title: "wrap test",
    createdAt: "2026-07-20T00:00:00Z",
    updatedAt: "2026-07-20T00:00:00Z",
    nodes,
    path,
    activeRootId: path[0]?.id ?? null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}
