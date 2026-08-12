import { createApi } from "../src/api.js";
import { attachHttpServer } from "../src/http-attach.js";

const [baseUrl] = process.argv.slice(2);
if (baseUrl === undefined) throw new Error("usage: bun test/live-actions-smoke.ts <url>");

const attach = await attachHttpServer(baseUrl);
const api = createApi(attach.origin, undefined, attach);
const created = await api.createStory("tui live actions smoke");
const first = await api.createNode(created.id, { parentId: null, instruction: "first", text: "First root." });
const firstId = requiredLeaf(first);
const second = await api.createNode(created.id, { parentId: null, instruction: "second", text: "Second root." });
const secondId = requiredLeaf(second);

const switched = await api.switchLine(created.id, firstId, { stopAtNode: true });
assert(switched.activeRootId === firstId && switched.path.at(-1)?.id === firstId, "switch response did not adopt requested root");
process.stdout.write(`switch payload: ${JSON.stringify({ nodeId: firstId, stopAtNode: true })}\n`);

const pruned = await api.deleteNode(created.id, secondId, 1);
assert(!pruned.nodes.some((node) => node.id === secondId), "prune response retained deleted node");
process.stdout.write(`prune payload: ${JSON.stringify({ expectedSubtreeCount: 1 })}\n`);

const tagged = await api.putBookmark(created.id, firstId, "smoke-canon", "Canon");
assert(tagged.tags.some((tag) => tag.nodeId === firstId
  && tag.name === "smoke-canon" && tag.status === "Canon"), "tag response shape mismatch");
process.stdout.write(`tag payload: ${JSON.stringify({ name: "smoke-canon", label: "Canon" })}\n`);

const untagged = await api.deleteBookmark(created.id, firstId);
assert(!untagged.tags.some((tag) => tag.nodeId === firstId), "tag delete response retained tag");
process.stdout.write(`tag delete: ${firstId} absent ✓\n`);

function requiredLeaf(payload: { path: Array<{ id: string }> }): string {
  const id = payload.path.at(-1)?.id;
  if (id === undefined) throw new Error("node creation returned no active leaf");
  return id;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Run C surface: export, autoname, facts CRUD, summary take.
const exported = await api.exportMarkdown(created.id);
if (!exported.includes("#")) throw new Error("export returned no markdown");
const named = await api.autonameStory(created.id);
if (named.title.trim().length === 0) throw new Error("autoname produced an empty title");
let withFact = await api.createFact(created.id, { tag: "Item", text: "Brass compass\nPoints at want." });
const factId = withFact.facts.at(-1)?.id;
if (factId === undefined) throw new Error("fact was not created");
withFact = await api.patchFact(created.id, factId, { tag: "Item", text: "Brass compass\nPoints at want, not north." });
if (!withFact.facts.some((fact) => fact.text.includes("not north"))) throw new Error("fact patch not applied");
withFact = await api.createFact(created.id, { tag: "Item", text: "Second item." });
withFact = await api.reorderFact(created.id, factId, 0);
if (withFact.facts[0]?.id !== factId) throw new Error("fact reorder not applied");
withFact = await api.deleteFact(created.id, withFact.facts[1]!.id);
withFact = await api.deleteFact(created.id, factId);
if (withFact.facts.some((fact) => fact.id === factId)) throw new Error("fact not deleted");
const summaryAbort = new AbortController();
let summaryDeltas = 0;
const summaryResult = await api.createSummaryTake(created.id, { nodeId: withFact.path.at(-1)!.id }, () => { summaryDeltas += 1; }, summaryAbort.signal);
if (summaryResult === null || summaryDeltas < 1) throw new Error("summary take did not stream and land");
const summaryNode = summaryResult.nodeId;
const adopted = await api.switchLine(created.id, summaryNode, { stopAtNode: true });
const final = adopted;
if (!final.path.some((node) => node.role === "summary")) throw new Error("summary node missing from line");
process.stdout.write(`export ${exported.length} chars · autoname "${named.title}" · facts CRUD ok · summary ◈ ${summaryNode} (${summaryDeltas} deltas)\n`);
