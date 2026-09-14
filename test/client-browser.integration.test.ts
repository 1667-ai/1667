import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import type * as Demo from "../client/demo.js";
import type * as Decoders from "../client/api-response-decoders.js";
import type * as Facade from "../client/worker-story-api.js";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("the shared client runs with browser globals only", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "1667-browser-client-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const entry = path.join(directory, "entry.ts");
  const bundle = path.join(directory, "browser.js");
  await writeFile(entry, [
    `import * as demo from ${JSON.stringify(path.join(root, "client/demo.ts"))};`,
    `import * as decoders from ${JSON.stringify(path.join(root, "client/api-response-decoders.ts"))};`,
    `import * as facade from ${JSON.stringify(path.join(root, "client/worker-story-api.ts"))};`,
    "globalThis.browserClient = { demo, decoders, facade };"
  ].join("\n"));
  await execFileAsync("bun", [
    "build", entry, "--target=browser", "--format=iife", `--outfile=${bundle}`
  ], { cwd: root, timeout: 60_000 });

  // Keep all three export surfaces in the bundle. No Node globals or module
  // loader are supplied: the renderer must own a real browser-only client.
  const browser = {
    TextEncoder, TextDecoder, URL, AbortController, AbortSignal,
    structuredClone, setTimeout, clearTimeout, crypto: webcrypto,
    browserClient: undefined as {
      demo: typeof Demo;
      decoders: typeof Decoders;
      facade: typeof Facade;
    } | undefined
  };
  runInNewContext(await readFile(bundle, "utf8"), browser, { timeout: 10_000 });
  assert.ok(browser.browserClient);
  const { demo, decoders, facade } = browser.browserClient;
  const api = demo.demoStoryApi(demo.createDemoController());
  const stories = await api.listStories();
  assert.ok(stories.length > 0);
  const story = await api.loadStory(stories[0]!.id);
  assert.ok(story.path.length > 0);
  const settings = decoders.decodeSettingsViewResponse(await api.getSettings());
  assert.equal(settings.document?.schemaVersion, 5);
  const renamed = await api.renameStory(story.id, "Browser manuscript");
  assert.equal(renamed.title, "Browser manuscript");
  assert.ok(api.createFactState);
  assert.ok(api.patchFactState);
  const factId = story.facts[0]!.id;
  const text = "🌙".repeat(60_000);
  const withState = await api.createFactState(story.id, factId, {
    anchorPartId: story.path.at(-1)!.id, text
  });
  const state = withState.facts.find((fact) => fact.id === factId)!.states.at(-1)!;
  assert.equal("text" in state && state.text, text);
  await assert.rejects(
    api.patchFactState(story.id, factId, state.id, { text: "" }),
    /Fact text cannot be empty/
  );
  const aside = await api.askAside(
    story.id, "Who holds the lantern?", () => {}, new AbortController().signal
  );
  assert.ok(aside);
  assert.equal(typeof facade.storyApiFromWorkerTransport, "function");
});
