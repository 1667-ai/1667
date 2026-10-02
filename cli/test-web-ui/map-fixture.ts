import type { StoryApi } from "../../client/api.js";
import type { Page } from "playwright-core";

/** Saves a screenshot when `AI_1667_MAP_SHOTS` names a directory; otherwise
 * does nothing, so an ordinary run writes no files. */
export async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.AI_1667_MAP_SHOTS;
  if (directory === undefined || directory === "") return;
  await page.screenshot({ path: `${directory}/web-map-${name}.png` });
}

export interface LargeStory {
  readonly storyId: string;
  readonly lines: number;
  readonly parts: number;
  readonly forks: number;
}

const TRUNK_PARTS = 1_300;
const BRANCHES = 80;
const SKETCHES = 20;
const FAN = 8;

/**
 * A story of about 1,500 parts and 90 lines: a long reading line, 80 short
 * branches forked along it, 20 sketches, and one part with a fan of 8 branches
 * (more lines alive at once than the gutter has lanes, so some park in the
 * overflow column). Every branch tail starts with `Branch <n> tail`.
 */
export async function seedLargeStory(api: StoryApi): Promise<LargeStory> {
  const paragraphs = Array.from({ length: TRUNK_PARTS }, (_, index) => `Trunk part ${index + 1} of the long reading line.`);
  const imported = await api.importMarkdown(`# Large Story\n\n${paragraphs.join("\n\n")}\n`);
  const storyId = imported.id;
  const trunk = imported.path.map((node) => node.id);
  const branch = async (parentId: string, name: string): Promise<void> => {
    const opening = await api.createNode(storyId, { text: `${name} opening part.`, parentId });
    await api.createNode(storyId, { text: `${name} tail of the branch.`, parentId: opening.path.at(-1)!.id });
  };
  for (let index = 0; index < BRANCHES; index += 1) {
    await branch(trunk[index * 10 + 5]!, `Branch ${index + 1}`);
  }
  for (let index = 0; index < SKETCHES; index += 1) {
    await api.createNode(storyId, { text: `Sketch ${index + 1} of a road not taken.`, parentId: trunk[index * 40 + 12]! });
  }
  for (let index = 0; index < FAN; index += 1) {
    await branch(trunk[450]!, `Fan ${index + 1}`);
  }
  // The reading line is the trunk again (the last branch switched away).
  await api.switchLine(storyId, trunk.at(-1)!);
  return {
    storyId,
    lines: 1 + BRANCHES + FAN,
    parts: TRUNK_PARTS + 2 * (BRANCHES + FAN) + SKETCHES,
    forks: BRANCHES + SKETCHES + 1
  };
}
