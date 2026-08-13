import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateDataDirectory } from "../server/data-directory-migration.js";
import {
  sha256,
  STORY_FORMAT,
  STORYTAVERN_REVISION_FORMAT,
  STORYTAVERN_STORY_FORMAT
} from "../server/story-format.js";
import {
  ABSENT_SETTINGS_V1,
  formatGenerationSettingsV1
} from "../server/settings-v1-codec.js";
import { StoryService } from "../server/story-service.js";

const STORY_ID = "storytavern-migration";
const NODE_ID = "opening";
const NOW = "2026-01-01T00:00:00.000Z";
const PROSE = "Legacy prose survives.";

test("offline migration opens StoryTavern bundles and normalizes later writes", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "1667-storytavern-migration-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "storytavern");
  const destination = path.join(parent, "1667");
  await mkdir(source);
  await writeFile(
    path.join(source, "settings.json"),
    formatGenerationSettingsV1(ABSENT_SETTINGS_V1)
  );
  const sourceManifest = await writeStoryTavernBundle(source);

  await migrateDataDirectory(source, destination);
  assert.equal(
    await readFile(
      path.join(destination, "stories", STORY_ID, "manifest.json"),
      "utf8"
    ),
    sourceManifest
  );

  const service = StoryService.withoutDiagnostics({ dataDir: destination });
  await service.init();
  try {
    const page = await service.listStoriesPage({
      cursor: null,
      maxEntries: 64
    });
    assert.deepEqual(page.items.map(({ id, title }) => ({ id, title })), [{
      id: STORY_ID,
      title: "StoryTavern story"
    }]);
    assert.match(await service.exportMarkdown(STORY_ID), /Legacy prose survives\./);
    await service.renameStory(STORY_ID, "Migrated story");
  } finally {
    await service.dispose();
  }

  const migratedManifest = JSON.parse(await readFile(
    path.join(destination, "stories", STORY_ID, "manifest.json"),
    "utf8"
  )) as {
    format: string;
    schemaVersion: number;
    content: { title: string; nodes: Array<{ revisionId: string }> };
  };
  assert.equal(migratedManifest.format, STORY_FORMAT);
  assert.equal(migratedManifest.schemaVersion, 6);
  assert.equal(migratedManifest.content.title, "Migrated story");
  const sourceDocument = JSON.parse(sourceManifest) as {
    format: string;
    nodes: Array<{ revisionId: string }>;
  };
  assert.equal(
    migratedManifest.content.nodes[0]!.revisionId,
    sourceDocument.nodes[0]!.revisionId
  );

  const retainedRevision = JSON.parse(await readFile(revisionPath(
    path.join(destination, "stories", STORY_ID),
    migratedManifest.content.nodes[0]!.revisionId
  ), "utf8")) as { format: string };
  assert.equal(retainedRevision.format, STORYTAVERN_REVISION_FORMAT);
  assert.equal(sourceDocument.format, STORYTAVERN_STORY_FORMAT);

  const restarted = StoryService.withoutDiagnostics({ dataDir: destination });
  await restarted.init();
  try {
    assert.match(await restarted.exportMarkdown(STORY_ID), /Legacy prose survives\./);
  } finally {
    await restarted.dispose();
  }
});

async function writeStoryTavernBundle(dataDir: string): Promise<string> {
  const bundle = path.join(dataDir, "stories", STORY_ID);
  const chunkHash = sha256(Buffer.from(PROSE, "utf8"));
  const revision = JSON.stringify({
    format: STORYTAVERN_REVISION_FORMAT,
    schemaVersion: 1,
    chunks: [chunkHash],
    utf16Length: PROSE.length
  });
  const revisionHash = sha256(Buffer.from(revision, "utf8"));
  await mkdir(path.dirname(chunkPath(bundle, chunkHash)), { recursive: true });
  await mkdir(path.dirname(revisionPath(bundle, revisionHash)), {
    recursive: true
  });
  await writeFile(chunkPath(bundle, chunkHash), PROSE);
  await writeFile(revisionPath(bundle, revisionHash), revision);
  const manifest = `${JSON.stringify({
    format: STORYTAVERN_STORY_FORMAT,
    schemaVersion: 5,
    id: STORY_ID,
    title: "StoryTavern story",
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: 3,
    nodes: [{
      id: NODE_ID,
      parentId: null,
      instruction: "",
      model: "legacy-model",
      createdAt: NOW,
      preview: PROSE,
      words: 3,
      tokens: 5,
      revisionId: revisionHash,
      activeChildId: null
    }],
    facts: [],
    activeRootId: NODE_ID,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  }, null, 2)}\n`;
  await writeFile(path.join(bundle, "manifest.json"), manifest);
  return manifest;
}

function chunkPath(bundle: string, hash: string): string {
  return path.join(bundle, "chunks", hash.slice(0, 2), `${hash}.txt`);
}

function revisionPath(bundle: string, hash: string): string {
  return path.join(bundle, "revisions", hash.slice(0, 2), `${hash}.json`);
}
