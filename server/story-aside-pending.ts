/**
 * Pending Aside document for one in-memory Story, cleared once encode stores
 * its content-addressed object. Mirrors the token-probability side table.
 */
import type { AsideDocument } from "../shared/aside.js";
import type { Story } from "../shared/types.js";

const pendingAside = new WeakMap<Story, AsideDocument>();

export function setPendingAsideDocument(story: Story, document: AsideDocument): void {
  pendingAside.set(story, document);
}

export function peekPendingAsideDocument(story: Story): AsideDocument | undefined {
  return pendingAside.get(story);
}

export function clearPendingAsideDocument(story: Story): void {
  pendingAside.delete(story);
}
