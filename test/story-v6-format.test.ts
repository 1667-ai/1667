import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  STORY_FORMAT,
  STORYTAVERN_STORY_FORMAT
} from "../server/story-format.js";
import {
  formatV6,
  formatV8,
  MAX_DELETED_STORY_MANIFEST_BYTES,
  parseStoryManifestBytes,
  parseStoryManifestText,
  storySummaryFromV6
} from "../server/story-v6-codec.js";
import { MAX_STORY_MANIFEST_BYTES } from "../server/story-v5-strict.js";
import { STORY_SCHEMA_SHA256 } from "../shared/story-schema-identity.js";
import { assertStorySchemaCorpus } from "../scripts/story-schema-validation.js";

interface CorpusCase {
  name: string;
  expectedId: string;
  valid: boolean;
  schemaValid: boolean;
  text: string;
}

interface Corpus {
  schemaVersion: number;
  cases: CorpusCase[];
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schemaText = readFileSync(path.join(ROOT, "schema", "story-manifest.schema.json"), "utf8");
const corpusText = readFileSync(path.join(ROOT, "schema", "story-manifest.corpus.json"), "utf8");
const corpus = JSON.parse(corpusText) as Corpus;

test("story schema: generated artifact is exact canonical Draft 2020-12 with its embedded hash", () => {
  const schema = JSON.parse(schemaText) as Record<string, unknown>;
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(canonicalJson(schema), schemaText);
  assert.equal(canonicalJson(JSON.parse(corpusText) as unknown), corpusText);
  assert.equal(createHash("sha256").update(schemaText).digest("hex"), STORY_SCHEMA_SHA256);
  assert.doesNotThrow(() => assertStorySchemaCorpus(schema, corpus.cases));
});

for (const fixture of corpus.cases) {
  test(`story schema corpus: ${fixture.name}`, () => {
    if (fixture.valid) {
      const parsed = parseStoryManifestText(fixture.text, fixture.expectedId);
      if (fixture.name.startsWith("v6-live")) assert.equal(parsed.kind, "v6-live");
      if (fixture.name === "v6-deleted") assert.equal(parsed.kind, "v6-deleted");
      if (fixture.name.startsWith("v5-")) assert.equal(parsed.kind, "v5");
      if (fixture.name.startsWith("v8-live")) assert.equal(parsed.kind, "v8-live");
    } else {
      assert.throws(() => parseStoryManifestText(fixture.text, fixture.expectedId));
    }
  });
}

test("story V6: formatter and summary adapter preserve the canonical live contract", () => {
  const fixture = corpus.cases.find((entry) => entry.name === "v6-live-revision-1");
  assert.ok(fixture);
  const parsed = parseStoryManifestText(fixture.text, fixture.expectedId);
  if (parsed.kind !== "v6-live") assert.fail("Expected the live V6 fixture to parse as live");
  const manifest = parsed.manifest;
  assert.equal(formatV6(manifest), fixture.text);
  assert.deepEqual(storySummaryFromV6(manifest), {
    id: "story-one",
    title: "Story",
    updatedAt: "2026-01-01T00:00:00.000Z",
    partCount: 0,
    words: 0,
    forked: false,
    lineCount: 0
  });
});

test("story V8: successor manifests round-trip with and without Image Attachments", () => {
  const withImages = corpus.cases.find((entry) => entry.name === "v8-live-with-images");
  const withoutImages = corpus.cases.find((entry) => entry.name === "v8-live-without-images");
  assert.ok(withImages);
  assert.ok(withoutImages);

  const parsedWithImages = parseStoryManifestText(withImages.text, withImages.expectedId);
  if (parsedWithImages.kind !== "v8-live") assert.fail("Expected the V8 fixture to parse as live");
  assert.equal(parsedWithImages.manifest.content.schemaVersion, 7);
  assert.equal(formatV8(parsedWithImages.manifest), withImages.text);
  assert.deepEqual(parsedWithImages.manifest.content.nodes[0]?.imageAttachments, [{
    objectId: "c".repeat(64),
    mediaType: "image/png",
    width: 800,
    height: 600,
    byteLength: 123_456
  }]);
  assert.deepEqual(storySummaryFromV6(parsedWithImages.manifest), {
    id: "story-one",
    title: "Story",
    updatedAt: "2026-01-01T00:00:00.000Z",
    partCount: 1,
    words: 0,
    forked: false,
    lineCount: 1
  });

  const parsedWithoutImages = parseStoryManifestText(withoutImages.text, withoutImages.expectedId);
  if (parsedWithoutImages.kind !== "v8-live") assert.fail("Expected the V8 fixture to parse as live");
  assert.equal(parsedWithoutImages.manifest.content.nodes.length, 0);
  assert.equal(formatV8(parsedWithoutImages.manifest), withoutImages.text);
});

test("story V8: a successor manifest is refused unless wrapped in its own envelope", () => {
  const bare = corpus.cases.find((entry) => entry.name === "v7-bare-payload-without-envelope");
  assert.ok(bare);
  assert.throws(
    () => parseStoryManifestText(bare.text, bare.expectedId),
    /successor|V8/
  );
});

test("story V6: StoryTavern identities normalize without changing story state", () => {
  const fixture = corpus.cases.find((entry) => entry.name === "v6-live-revision-1");
  assert.ok(fixture);
  const legacyText = fixture.text.replaceAll(
    STORY_FORMAT,
    STORYTAVERN_STORY_FORMAT
  );
  const parsed = parseStoryManifestText(legacyText, fixture.expectedId);
  if (parsed.kind !== "v6-live") assert.fail("Expected the StoryTavern V6 fixture to parse as live");

  assert.equal(parsed.manifest.format, STORY_FORMAT);
  assert.equal(parsed.manifest.content.format, STORY_FORMAT);
  assert.equal(formatV6(parsed.manifest), fixture.text);
});

test("story manifests: byte ceilings and UTF-8 failures reject before wire parsing", () => {
  assert.throws(
    () => parseStoryManifestBytes(Buffer.alloc(MAX_STORY_MANIFEST_BYTES + 1, 0x20), "story-one"),
    /size limit/
  );
  assert.throws(() => parseStoryManifestBytes(Uint8Array.of(0xff), "story-one"), /valid UTF-8/);
  assert.throws(
    () => parseStoryManifestBytes(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d), "story-one"),
    /BOM/
  );

  const deleted = corpus.cases.find((entry) => entry.name === "v6-deleted");
  assert.ok(deleted);
  const padded = `${deleted.text}${" ".repeat(MAX_DELETED_STORY_MANIFEST_BYTES)}`;
  assert.throws(() => parseStoryManifestText(padded, deleted.expectedId), /Deleted story manifest exceeds/);
});

test("story manifests: V2-V4 retain replacement decoding while V5 stays strict", () => {
  const common = {
    format: "1667-story",
    id: "legacy-utf8",
    title: "x",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    activeWordCount: 0,
    nodes: [],
    facts: [],
    activeRootId: null,
    bookmarks: [],
    recentNodeIds: []
  };
  const legacyBytes = corruptTitleByte({ ...common, schemaVersion: 4 });
  const legacy = parseStoryManifestBytes(legacyBytes, common.id);
  assert.equal(legacy.kind, "v5");
  if (legacy.kind === "v5") assert.equal(legacy.manifest.title, "\ufffd");

  const strictBytes = corruptTitleByte({ ...common, schemaVersion: 5, chapterBreaks: [] });
  assert.throws(() => parseStoryManifestBytes(strictBytes, common.id), /valid UTF-8/);
});

test("story V5: Unicode-scalar title bounds do not count surrogate pairs twice", () => {
  const fixture = corpus.cases.find((entry) => entry.name === "v5-minimal");
  assert.ok(fixture);
  const manifest = JSON.parse(fixture.text) as Record<string, unknown>;
  manifest.title = "😀".repeat(4_096);
  assert.equal(parseStoryManifestText(JSON.stringify(manifest), fixture.expectedId).kind, "v5");
  manifest.title = `${manifest.title}😀`;
  assert.throws(() => parseStoryManifestText(JSON.stringify(manifest), fixture.expectedId), /4,096/);
});

test("story V5: nested string bounds count scalars and reject non-scalar surrogates", () => {
  const fixture = corpus.cases.find((entry) => entry.name === "v5-complete-optional-shape");
  assert.ok(fixture);
  const manifest = JSON.parse(fixture.text) as {
    title: string;
    nodes: Array<{ preview?: string }>;
    facts: Array<{ tag: string | null }>;
    bookmarks: Array<{ name: string }>;
  };
  manifest.nodes[0]!.preview = "😀".repeat(100);
  manifest.facts[0]!.tag = "😀".repeat(48);
  manifest.bookmarks[0]!.name = "😀".repeat(80);
  assert.equal(parseStoryManifestText(JSON.stringify(manifest), fixture.expectedId).kind, "v5");

  manifest.nodes[0]!.preview += "😀";
  assert.throws(() => parseStoryManifestText(JSON.stringify(manifest), fixture.expectedId), /100/);
  manifest.nodes[0]!.preview = "ok";
  manifest.title = "\ud800";
  assert.throws(() => parseStoryManifestText(JSON.stringify(manifest), fixture.expectedId), /unpaired/);
});

function corruptTitleByte(manifest: Record<string, unknown>): Buffer {
  const bytes = Buffer.from(JSON.stringify(manifest));
  const title = bytes.indexOf(Buffer.from('"title":"x"'));
  assert.notEqual(title, -1);
  bytes[title + '"title":"'.length] = 0xff;
  return bytes;
}
