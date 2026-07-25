import type { Story } from "../shared/types.js";

const autonameIds = new WeakMap<Story, string>();

export function storyAutonameId(story: Story): string | undefined {
  return autonameIds.get(story);
}

export function setStoryAutonameId(story: Story, autonameId: string | undefined): void {
  if (autonameId === undefined) autonameIds.delete(story);
  else autonameIds.set(story, autonameId);
}
