import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { StoryService } from "../server/story-service.js";
import { partsFromMarkdown } from "../server/import-md.js";
import { storyFromImport } from "../server/import-st.js";
import { parseImportCommand } from "../tui/src/import-cli.js";
import { initializeProject } from "../server/project-discovery.js";
import type { StoryPayload } from "../shared/types.js";
import {
  decodeMarkdownHttpBody,
  encodeMarkdownHttpBody,
  MAX_MARKDOWN_HTTP_BODY_BYTES
} from "../shared/import-markdown-wire.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import { testApp } from "./story-server-fixture.js";

const execFileAsync = promisify(execFile);
const linuxTest = process.platform === "linux" ? test : test.skip;

function isServiceError(error: unknown, status: number, messageSub: string): boolean {
  return error instanceof Error
    && "status" in error
    && (error as { status?: number }).status === status
    && error.message.includes(messageSub);
}

function isErrorWithMessage(error: unknown, messageSub: string): boolean {
  return error instanceof Error && error.message.includes(messageSub);
}

test("partsFromMarkdown parses title, prose paragraphs, and ## chapter breaks", () => {
  const markdown = `# The Great Adventure

<!-- derived from "Source" (story source-id, node node-id) -->

First paragraph of opening chapter.

Second paragraph of opening chapter.

## Chapter 2: The Dark Forest

First paragraph of chapter 2.

Second paragraph of chapter 2.

## Chapter 3: The Summit

Only paragraph of chapter 3.
`;

  const parsed = partsFromMarkdown(markdown, "Fallback Title");
  assert.equal(parsed.title, "The Great Adventure");
  assert.equal(parsed.parts.length, 5);
  assert.equal(parsed.parts[0]?.text, "First paragraph of opening chapter.");
  assert.equal(parsed.parts[1]?.text, "Second paragraph of opening chapter.");
  assert.equal(parsed.parts[2]?.text, "First paragraph of chapter 2.");
  assert.equal(parsed.parts[3]?.text, "Second paragraph of chapter 2.");
  assert.equal(parsed.parts[4]?.text, "Only paragraph of chapter 3.");

  assert.equal(parsed.chapterBreaks.length, 2);
  assert.deepEqual(parsed.chapterBreaks[0], {
    parentPartIndex: 1,
    title: "Chapter 2: The Dark Forest"
  });
  assert.deepEqual(parsed.chapterBreaks[1], {
    parentPartIndex: 3,
    title: "Chapter 3: The Summit"
  });
});

test("partsFromMarkdown preserves trailing H2 chapter break by attaching to preceding part at EOF", () => {
  const markdown = `# Story Title

Part 1 content.

Part 2 content.

## Trailing Chapter
`;

  const parsed = partsFromMarkdown(markdown);
  assert.equal(parsed.parts.length, 2);
  assert.equal(parsed.chapterBreaks.length, 1);
  assert.deepEqual(parsed.chapterBreaks[0], {
    parentPartIndex: 1,
    title: "Trailing Chapter"
  });
});

test("markdown import preserves long titles up to stored bound (4096 chars) without SillyTavern MAX_NAME truncation", () => {
  const longStoryTitle = "A".repeat(4096);
  const longChapterTitle = "B".repeat(4096);
  const markdown = `# ${longStoryTitle}\n\nPart 1 text.\n\n## ${longChapterTitle}\n\nPart 2 text.`;

  const parsed = partsFromMarkdown(markdown);
  assert.equal(parsed.title.length, 4096);
  assert.equal(parsed.title, longStoryTitle);
  assert.equal(parsed.chapterBreaks[0]?.title.length, 4096);
  assert.equal(parsed.chapterBreaks[0]?.title, longChapterTitle);

  const emojiTitle = "😀".repeat(3_000);
  const scalarParsed = partsFromMarkdown(
    `# ${emojiTitle}\n\nPart 1.\n\n## ${emojiTitle}\n\nPart 2.`
  );
  assert.equal(scalarParsed.title, emojiTitle);
  assert.equal(scalarParsed.chapterBreaks[0]?.title, emojiTitle);
});

test("Markdown HTTP framing preserves the scalar title bound", () => {
  const title = "😀".repeat(4_097);
  const decoded = decodeMarkdownHttpBody(encodeMarkdownHttpBody("prose", title));
  assert.equal(decoded.defaultTitle, "😀".repeat(4_096));
  assert.equal(decoded.markdown, "prose");
  const oversizedTitle = Buffer.from("a".repeat(4_097)).toString("base64url");
  assert.throws(
    () => decodeMarkdownHttpBody(`${oversizedTitle}\nprose`),
    /metadata is invalid/u
  );
  assert.throws(() => encodeMarkdownHttpBody("\uD800"), /invalid Unicode/u);
  assert.throws(
    () => encodeMarkdownHttpBody("prose", "\uD800"),
    /invalid Unicode/u
  );
});

test("markdown recognizes only CommonMark H2 markers and preserves ##literal prose", () => {
  const parsed = partsFromMarkdown("# Title\n\n##literal\n\n##\tChapter\n\nNext part.");
  assert.equal(parsed.parts[0]?.text, "##literal");
  assert.equal(parsed.chapterBreaks[0]?.title, "Chapter");
});

test("markdown preserves prose comments and ignores only generated origin metadata", () => {
  const parsed = partsFromMarkdown([
    "# Title",
    "",
    "<!-- derived from \"Source\" (story source-id, node node-id @ 4) -->",
    "",
    "Before <!-- keep --> after"
  ].join("\n"));
  assert.equal(parsed.parts[0]?.text, "Before <!-- keep --> after");
});

test("markdown keeps indented and fenced heading markers as prose", () => {
  const parsed = partsFromMarkdown([
    "# Title",
    "",
    "    ## indented literal",
    "",
    "```markdown",
    "## fenced literal",
    "```",
    "",
    "## Real chapter",
    "",
    "Next part."
  ].join("\n"));
  assert.equal(parsed.parts[0]?.text, "    ## indented literal");
  assert.equal(parsed.parts[1]?.text, "```markdown\n## fenced literal\n```");
  assert.equal(parsed.parts[2]?.text, "Next part.");
  assert.equal(parsed.chapterBreaks[0]?.title, "Real chapter");
});

test("markdown accepts CR-only line endings as physical lines", () => {
  const parsed = partsFromMarkdown("# Title\r\rFirst\r\rSecond");
  assert.equal(parsed.title, "Title");
  assert.deepEqual(parsed.parts.map(({ text }) => text), ["First", "Second"]);
});

test("markdown comment scanning remains linear for unterminated openers", () => {
  const prose = "<!--".repeat(100_000);
  const parsed = partsFromMarkdown(`# Title\n\n${prose}`);
  assert.equal(parsed.parts[0]?.text, prose);
});

test("markdown manifest admission charges chapter titles and structural metadata", () => {
  const chapterTitle = "x".repeat(2_000);
  const markdown = [
    "# Title",
    "opening",
    ...Array.from({ length: 4_000 }, (_, index) => `## ${chapterTitle}\n\npart ${index}`)
  ].join("\n\n");
  assert.ok(Buffer.byteLength(markdown) < 20 * 1024 * 1024);
  assert.throws(
    () => partsFromMarkdown(markdown),
    (error: unknown) => isServiceError(error, 400, "stored story manifest limit")
  );
});

test("export and reimport round-trip preserves story structure and re-exported markdown", async (t) => {
  const service = await openService(t);
  const created = await service.createStory("The Tavern After Rain");

  const opening = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: [
      "<!-- derived from \"User prose\" (story prose, node prose) -->",
      "Rain still ran off the eaves."
    ].join("\n")
  });
  const firstPart = opening.nodes.find((node) => node.parentId === null)!;

  const secondNode = await service.createNode(created.id, {
    parentId: firstPart.id,
    instruction: "",
    text: [
      "The second part of chapter 1. Before <!-- keep --> after.",
      "```markdown",
      "## fenced literal",
      "```"
    ].join("\n")
  });
  const secondPart = secondNode.nodes.find((node) => node.parentId === firstPart.id)!;

  await service.createChapterBreak(created.id, secondPart.id, "After the Rain");

  await service.createNode(created.id, {
    parentId: secondPart.id,
    instruction: "",
    text: "The third part in chapter 2."
  });

  // Export story
  const exported = await service.exportStory(created.id);
  assert.equal(exported.filename, "The_Tavern_After_Rain.md");
  assert.ok(exported.markdown.includes("# The Tavern After Rain"));
  assert.ok(exported.markdown.includes("## After the Rain"));

  // Reimport as a new story
  const reimportedPayload = await service.importMarkdown(exported.markdown);
  assert.equal(reimportedPayload.title, "The Tavern After Rain");
  assert.equal(reimportedPayload.nodes.length, 3);
  assert.equal(reimportedPayload.chapterBreaks.length, 1);
  assert.equal(reimportedPayload.chapterBreaks[0]?.title, "After the Rain");

  // Re-export the reimported story
  const reexported = await service.exportStory(reimportedPayload.id);
  assert.equal(reexported.markdown, exported.markdown);
});

test("export and reimport round-trip preserves a title-only empty story", async (t) => {
  const service = await openService(t);
  const created = await service.createStory("Empty but exportable");
  const exported = await service.exportStory(created.id);
  const reimported = await service.importMarkdown(exported.markdown);
  assert.equal(reimported.title, "Empty but exportable");
  assert.deepEqual(reimported.nodes, []);
  assert.equal((await service.exportStory(reimported.id)).markdown, exported.markdown);
});

test("export codec preserves multiline titles and chapters after an unterminated prose fence", async (t) => {
  const service = await openService(t);
  const created = await service.createStory("First line\n\nSecond line");
  const opening = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: [
      "```markdown",
      "<!-- 1667:chapter:v1 -->",
      "<!--\u200B 1667:chapter:v1 -->",
      "x".repeat(120),
      "Cafe\u0301",
      "unterminated fence"
    ].join("\n")
  });
  const firstPart = opening.nodes.find((node) => node.parentId === null)!;
  await service.createChapterBreak(created.id, firstPart.id, "Chapter\n\nTwo");
  await service.createNode(created.id, {
    parentId: firstPart.id,
    instruction: "",
    text: "Still\r\na separate part."
  });

  const exported = await service.exportStory(created.id);
  const reimported = await service.importMarkdown(exported.markdown);
  assert.equal(reimported.title, "First line\n\nSecond line");
  assert.deepEqual(reimported.path.map(({ text }) => text), [
    [
      "```markdown",
      "<!-- 1667:chapter:v1 -->",
      "<!--\u200B 1667:chapter:v1 -->",
      "x".repeat(120),
      "Cafe\u0301",
      "unterminated fence"
    ].join("\n"),
    "Still\r\na separate part."
  ]);
  assert.equal(reimported.chapterBreaks[0]?.title, "Chapter\n\nTwo");
  assert.equal((await service.exportStory(reimported.id)).markdown, exported.markdown);

  const editedMarkdown = exported.markdown
    .replace(/^# .*$/mu, "# Edited title")
    .replace(/^## .*$/mu, "## Edited chapter");
  const edited = await service.importMarkdown(editedMarkdown);
  assert.equal(edited.title, "Edited title");
  assert.equal(edited.chapterBreaks[0]?.title, "Edited chapter");
});

test("storyFromImport generates deterministic chapter break IDs when supplied", () => {
  const markdown = `# Title\n\nPart 1.\n\n## Chapter 2\n\nPart 2.\n`;
  const parsed = partsFromMarkdown(markdown);
  const story = storyFromImport(parsed, {
    storyId: "s_det",
    nodeId: (index) => `n_${index}`,
    chapterBreakId: (index) => `cb_${index}`
  });
  assert.equal(story.id, "s_det");
  assert.equal(story.nodes[0]?.id, "n_0");
  assert.equal(story.nodes[1]?.id, "n_1");
  assert.equal(story.chapterBreaks[0]?.id, "cb_0");
  assert.equal(story.chapterBreaks[0]?.parentPartId, "n_0");
});

test("markdown import enforces import byte and part limits", () => {
  assert.throws(
    () => partsFromMarkdown(""),
    (error: unknown) => isServiceError(error, 400, "No importable prose")
  );

  const hugeParagraphs = Array.from({ length: 5001 }, (_, i) => `Paragraph ${i}`).join("\n\n");
  assert.throws(
    () => partsFromMarkdown(hugeParagraphs),
    (error: unknown) => isServiceError(error, 400, "5000 parts")
  );
  assert.throws(
    () => partsFromMarkdown([
      "# Story",
      "<!-- 1667:export:v1 -->",
      "<!-- 1667:chapter:v1 -->"
    ].join("\n\n")),
    (error: unknown) => isServiceError(error, 400, "missing its heading")
  );
});

test("markdown import keeps one long multi-line paragraph in bounded parser state", () => {
  const parsed = partsFromMarkdown(`x\n`.repeat(100_000));
  assert.equal(parsed.parts.length, 1);
  assert.equal(parsed.parts[0]?.text.length, 199_999);
});

test("CLI parseImportCommand parses files and flags correctly", () => {
  assert.deepEqual(parseImportCommand(["file1.md", "file2.jsonl"]), {
    files: ["file1.md", "file2.jsonl"],
    data: null,
    global: false
  });
  assert.deepEqual(parseImportCommand(["--data", "myproject", "story.md"]), {
    files: ["story.md"],
    data: "myproject",
    global: false
  });
  assert.throws(
    () => parseImportCommand([]),
    (error: unknown) => isErrorWithMessage(error, "at least one file argument")
  );
  assert.throws(
    () => parseImportCommand(["--global", "--data", "foo", "bar.md"]),
    (error: unknown) => isErrorWithMessage(error, "select different projects")
  );
});

linuxTest("HTTP POST /api/import/markdown accepts framed Markdown and fallback defaultTitle", async (t) => {
  const base = await testApp(t, "1667-import-md-http-");
  const markdownBody = "Prose without a title heading.";
  const response = await fetchWithApiProtocol(`${base}/api/import/markdown`, {
    method: "POST",
    headers: {
      ...API_PROTOCOL_HEADERS,
      "content-type": "application/vnd.1667.markdown; charset=utf-8"
    },
    body: encodeMarkdownHttpBody(markdownBody, "Custom Default Title")
  });
  assert.equal(response.status, 201);
  const payload = await response.json() as StoryPayload;
  assert.equal(payload.title, "Custom Default Title");
  assert.equal(payload.path[0]?.text, "Prose without a title heading.");

  const unicodeResponse = await fetchWithApiProtocol(`${base}/api/import/markdown`, {
    method: "POST",
    headers: {
      ...API_PROTOCOL_HEADERS,
      "content-type": "application/vnd.1667.markdown; charset=utf-8"
    },
    body: encodeMarkdownHttpBody("# Cafe\u0301\n\nRe\u0301sume\u0301.")
  });
  assert.equal(unicodeResponse.status, 201);
  const unicodePayload = await unicodeResponse.json() as StoryPayload;
  assert.equal(unicodePayload.title, "Café");
  assert.equal(unicodePayload.path[0]?.text, "Résumé.");
});

linuxTest("HTTP POST /api/import/markdown bounds raw Markdown without JSON escape amplification", async (t) => {
  const base = await testApp(t, "1667-import-md-expanded-");
  const rawMarkdown = "# Expansion Test\n\n" + "\\\"".repeat(500_000);

  const response = await fetchWithApiProtocol(`${base}/api/import/markdown`, {
    method: "POST",
    headers: {
      ...API_PROTOCOL_HEADERS,
      "content-type": "application/vnd.1667.markdown; charset=utf-8"
    },
    body: encodeMarkdownHttpBody(rawMarkdown)
  });
  assert.equal(response.status, 201);
  const payload = await response.json() as StoryPayload;
  assert.equal(payload.title, "Expansion Test");

  const oversizedMarkdown = "a".repeat(20_000_001);
  const overResponse = await fetchWithApiProtocol(`${base}/api/import/markdown`, {
    method: "POST",
    headers: {
      ...API_PROTOCOL_HEADERS,
      "content-type": "application/vnd.1667.markdown; charset=utf-8"
    },
    body: encodeMarkdownHttpBody(oversizedMarkdown)
  });
  assert.equal(overResponse.status, 413);

  const framedOverResponse = await fetchWithApiProtocol(`${base}/api/import/markdown`, {
    method: "POST",
    headers: {
      ...API_PROTOCOL_HEADERS,
      "content-type": "application/vnd.1667.markdown; charset=utf-8"
    },
    body: "a".repeat(MAX_MARKDOWN_HTTP_BODY_BYTES + 1)
  });
  assert.equal(framedOverResponse.status, 413);
  assert.equal((await framedOverResponse.json() as { code?: string }).code, "content_too_large");
});

test("E2E integration: 1667 import routes to a project and returns a failure exit status", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-tui-cli-import-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const project = await initializeProject(root);
  const sampleMd = path.join(root, "sample.md");
  await writeFile(sampleMd, "\uFEFF# TUI Imported Story\n\nFirst paragraph.", "utf8");

  const bun = process.execPath.includes("bun") ? process.execPath : "bun";
  const entrypoint = path.resolve("tui/src/standalone.ts");
  const imported = await execFileAsync(
    bun,
    [entrypoint, "import", "--data", project.root, sampleMd],
    { env: { ...process.env, AI_1667_STATE: path.join(root, "machine") } }
  );
  assert.match(imported.stdout, /imported "TUI Imported Story"/u);

  const service = StoryService.withoutDiagnostics({ dataDir: project.directory });
  await service.init();
  const list = await service.listStories();
  assert.ok(list.some(({ title }) => title === "TUI Imported Story"));
  await service.dispose();

  const failure = await execFileAsync(
    bun,
    [entrypoint, "import", "--data", project.root, path.join(root, "missing.md")],
    { env: { ...process.env, AI_1667_STATE: path.join(root, "machine") } }
  ).catch((error: unknown) => error);
  assert.ok(failure instanceof Error && "code" in failure && failure.code === 1);
  assert.ok("stderr" in failure && String(failure.stderr).includes("ENOENT"));

  if (process.platform !== "win32") {
    const fifo = path.join(root, "blocked.md");
    await execFileAsync("mkfifo", [fifo]);
    const fifoFailure = await execFileAsync(
      bun,
      [entrypoint, "import", "--data", project.root, fifo],
      {
        env: { ...process.env, AI_1667_STATE: path.join(root, "machine") },
        timeout: 5_000
      }
    ).catch((error: unknown) => error);
    assert.ok(fifoFailure instanceof Error && "code" in fifoFailure && fifoFailure.code === 1);
    assert.ok(
      "stderr" in fifoFailure
      && String(fifoFailure.stderr).includes("not a regular file")
    );
  }
});

test("E2E integration: npm import persists through the root maintenance boundary", {
  skip: process.platform === "win32"
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-server-cli-import-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const sampleMd = path.join(root, "server-sample.md");
  await writeFile(sampleMd, "# Server CLI Story\n\nServer prose.", "utf8");

  const dataDir = path.join(root, "data");
  const environment = {
    ...process.env,
    AI_1667_DATA: dataDir,
    AI_1667_STATE: path.join(root, "machine")
  };
  const { stdout } = await execFileAsync("npm", ["run", "import", "--", sampleMd], {
    env: environment
  });
  assert.ok(stdout.includes('imported "Server CLI Story"'));

  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  assert.deepEqual((await service.listStories()).map(({ title }) => title), ["Server CLI Story"]);
  await service.dispose();

  const failure = await execFileAsync("npm", ["run", "import", "--", "nonexistent.md"], {
    env: environment
  }).catch((error: unknown) => error);
  assert.ok(failure instanceof Error && "code" in failure && failure.code === 1);
  assert.ok("stderr" in failure && String(failure.stderr).includes("ENOENT"));
});

async function openService(t: TestContext): Promise<StoryService> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-import-service-"));
  const service = StoryService.withoutDiagnostics({
    dataDir: path.join(root, "project")
  });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return service;
}
