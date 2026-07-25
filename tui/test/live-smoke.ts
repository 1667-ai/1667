import { createApi } from "../src/api.js";
import { attachHttpServer } from "../src/http-attach.js";

const [baseUrl, storyId] = process.argv.slice(2);
if (baseUrl === undefined || storyId === undefined) throw new Error("usage: bun test/live-smoke.ts <url> <story-id>");
const attach = await attachHttpServer(baseUrl);
const api = createApi(attach.origin, undefined, attach);
const before = await api.loadStory(storyId);
const abort = new AbortController();
let deltas = 0;
const result = await api.continueStory(
  storyId,
  "",
  crypto.randomUUID(),
  { parentId: null },
  () => {
    deltas += 1;
    abort.abort();
  },
  abort.signal
);
const after = await api.loadStory(storyId);
if (result !== null) throw new Error("aborted stream unexpectedly completed");
if (deltas < 1) throw new Error("dry-run provider emitted no delta before abort");
if (after.nodes.length !== before.nodes.length) throw new Error("aborted stream committed a node");
process.stdout.write(`loaded ${storyId}: ${before.nodes.length} nodes\n`);
process.stdout.write(`aborted after ${deltas} delta; result=null\n`);
process.stdout.write(`reloaded ${storyId}: ${after.nodes.length} nodes (discard confirmed)\n`);
