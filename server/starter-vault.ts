// Writes the starter stories into a data directory this process just created.
//
// Everything is replayed through the ordinary authoring commands, so the vault
// lands in whatever schema the build currently writes. There is no snapshot to
// migrate: a schema change that breaks the starter stories breaks every story,
// and is caught by the same tests.

import { createHash } from "node:crypto";
import {
  STARTER_OPENING_STORY_ID,
  STARTER_STORIES,
  type StarterStory
} from "../shared/starter-vault.js";

/** The authoring surface the seeder needs, kept structural so this module does
 * not import the service that calls it. */
export interface StarterVaultTarget {
  createStory(title?: string, storyId?: string): Promise<unknown>;
  createNode(id: string, value: unknown, nodeId?: string): Promise<unknown>;
  switchLine(id: string, nodeId: string): Promise<unknown>;
  putBookmark(id: string, nodeId: string, name: string, label: string): Promise<unknown>;
  createChapterBreak(
    id: string,
    parentPartId: string,
    title: string,
    chapterBreakId?: string
  ): Promise<unknown>;
}

/** Derive a stable UUID for a starter part. Every install lays the vault out
 * identically, and the create commands treat a known id as already-done, so a
 * seed that runs twice repairs rather than duplicates. */
function derivedId(storyId: string, kind: string, slug: string): string {
  const hex = createHash("sha256")
    .update(`1667-starter-vault-v1\0${storyId}\0${kind}\0${slug}`, "utf8")
    .digest("hex");
  const variant = "89ab"[Number.parseInt(hex.slice(16, 17), 16) % 4]!;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join("-");
}

export async function seedStarterVault(target: StarterVaultTarget): Promise<void> {
  // Clients open the most recently updated story, so the tour has to be the
  // last thing written. Seeding it first is what makes a fresh install open on
  // the wrong story.
  const ordered = [...STARTER_STORIES].sort(
    (left, right) => Number(left.id === STARTER_OPENING_STORY_ID)
      - Number(right.id === STARTER_OPENING_STORY_ID)
  );
  for (const story of ordered) await seedStory(target, story);
}

async function seedStory(target: StarterVaultTarget, story: StarterStory): Promise<void> {
  await target.createStory(story.title, story.id);

  const chapters: { parentPartId: string; title: string }[] = [];
  const bookmarks: { nodeId: string; name: string; label: string }[] = [];
  let parentId: string | null = null;
  let lineEnd: string | null = null;

  for (const beat of story.beats) {
    if (beat.chapter !== undefined && parentId !== null) {
      chapters.push({ parentPartId: parentId, title: beat.chapter });
    }
    let active: string | null = null;
    for (const take of beat.takes) {
      const nodeId = derivedId(story.id, "part", take.slug);
      await target.createNode(
        story.id,
        {
          text: take.text,
          ...(take.instruction === undefined ? {} : { instruction: take.instruction }),
          parentId
        },
        nodeId
      );
      active ??= nodeId;
      if (take.bookmark !== undefined) {
        bookmarks.push({ nodeId, name: take.bookmark.name, label: take.bookmark.label });
      }
    }
    parentId = active;
    lineEnd = active;
  }

  for (const chapter of chapters) {
    await target.createChapterBreak(
      story.id,
      chapter.parentPartId,
      chapter.title,
      derivedId(story.id, "chapter", chapter.title)
    );
  }

  // Each new take activates itself, so the line currently runs through the last
  // take of every beat. Put it back on the first before anything reads it.
  if (lineEnd !== null) await target.switchLine(story.id, lineEnd);

  // Bookmarks land last on purpose: bookmarking a line end and then extending
  // it migrates the bookmark onto the new child, which would silently move
  // every marker the tour points at.
  for (const bookmark of bookmarks) {
    await target.putBookmark(story.id, bookmark.nodeId, bookmark.name, bookmark.label);
  }
}
