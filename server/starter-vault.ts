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
import { uuidFromDigestHex } from "./deterministic-uuid.js";
import type { StoryService } from "./story-service.js";

/** Derive a stable UUID for a starter part. Every install lays the vault out
 * identically, and the create commands treat a known id as already-done, so a
 * seed that runs twice repairs rather than duplicates. */
function derivedId(storyId: string, kind: string, slug: string): string {
  return uuidFromDigestHex(
    createHash("sha256")
      .update(`1667-starter-vault-v1\0${storyId}\0${kind}\0${slug}`, "utf8")
      .digest("hex")
  );
}

export async function seedStarterVault(service: StoryService): Promise<void> {
  // Clients open the most recently updated story, so the tour has to be the
  // last thing written. Seeding it first is what makes a fresh install open on
  // the wrong story.
  const opening = STARTER_STORIES.filter((story) => story.id === STARTER_OPENING_STORY_ID);
  const rest = STARTER_STORIES.filter((story) => story.id !== STARTER_OPENING_STORY_ID);
  for (const story of [...rest, ...opening]) await seedStory(service, story);
}

async function seedStory(service: StoryService, story: StarterStory): Promise<void> {
  await service.createStory(story.title, story.id);

  const chapters: { parentPartId: string; title: string }[] = [];
  const bookmarks: { nodeId: string; name: string; label: string }[] = [];
  // Every take and its seam is known before any of them is written, so the
  // whole vault lands in one aggregate change instead of one for each take.
  const takes: { value: unknown; nodeId: string }[] = [];
  let parentId: string | null = null;

  for (const beat of story.beats) {
    if (beat.chapter !== undefined) {
      if (parentId === null) {
        throw new Error(
          `Starter story ${story.title} opens a chapter on its first beat, which has no seam to anchor to`
        );
      }
      chapters.push({ parentPartId: parentId, title: beat.chapter });
    }
    for (const take of beat.takes) {
      const nodeId = derivedId(story.id, "part", take.slug);
      takes.push({
        value: {
          text: take.text,
          ...(take.instruction === undefined ? {} : { instruction: take.instruction }),
          parentId
        },
        nodeId
      });
      if (take.bookmark !== undefined) {
        bookmarks.push({ nodeId, name: take.bookmark.name, label: take.bookmark.label });
      }
    }
    // The first take carries the line onward; the rest hang off the same seam
    // as alternatives. A beat always has one, so this never re-roots the story.
    parentId = derivedId(story.id, "part", beat.takes[0].slug);
  }
  await service.createNodes(story.id, takes);

  for (const chapter of chapters) {
    await service.createChapterBreak(
      story.id,
      chapter.parentPartId,
      chapter.title,
      derivedId(story.id, "chapter", chapter.title)
    );
  }

  // Each new take activates itself, so the line currently runs through the last
  // take of every beat. Put it back on the first before anything reads it.
  if (parentId !== null) await service.switchLine(story.id, parentId);

  // Bookmarks land last on purpose: bookmarking a line end and then extending
  // it migrates the bookmark onto the new child, which would silently move
  // every marker the tour points at.
  for (const bookmark of bookmarks) {
    await service.putBookmark(story.id, bookmark.nodeId, bookmark.name, bookmark.label);
  }
}
