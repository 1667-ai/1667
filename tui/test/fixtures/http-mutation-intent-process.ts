import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PrivateHttpMutationIntentStore
} from "../../src/http-mutation-intents.js";

const [root, index = "unknown", action = "claim"] = process.argv.slice(2);
if (root === undefined) throw new Error("Missing private state root");

const store = await PrivateHttpMutationIntentStore.create({
  dataDirectoryId: "aa".repeat(32),
  dataDirectoryClaimId: "ca".repeat(32),
  origin: "http://127.0.0.1:7373",
  privateStateRoot: root
});
const existingClaim = action === "complete"
  ? await store.claim("createStory", "Concurrent story")
  : null;
await writeFile(path.join(root, `ready-${index}`), "");
const gate = path.join(root, "claim-gate");
while (!await access(gate).then(
  () => true,
  () => false
)) {
  await new Promise((resolve) => setTimeout(resolve, 1));
}
const claim = existingClaim
  ?? await store.claim("createStory", "Concurrent story");
if (action === "complete") await claim.complete();
console.log(claim.mutationId);
