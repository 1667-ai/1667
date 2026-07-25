import { readFile, stat } from "node:fs/promises";
import { MAX_IMPORT_BYTES } from "./import-st.js";
import { StoryService } from "./story-service.js";

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error("Usage: npm run import -- <chat.jsonl> [more.jsonl...]");
  process.exit(1);
}

/** Strip terminal control characters from untrusted file names and titles. */
function plain(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
}

const service = new StoryService({ settingsActivation: "recover-only" });
await service.init();
let failed = false;
try {
  for (const file of files) {
    try {
      const { size } = await stat(file);
      if (size > MAX_IMPORT_BYTES) {
        throw new Error(`file is ${Math.round(size / 1e6)}MB — larger than the ${MAX_IMPORT_BYTES / 1e6}MB import limit`);
      }
      const imported = await service.importSillyTavernWithReport(await readFile(file, "utf8"));
      const dropped = imported.droppedTrailingUserMessages;
      console.log(
        `${plain(file)}: imported "${plain(imported.payload.title)}" (${imported.payload.nodes.length} parts) as ${imported.payload.id}` +
          (dropped > 0 ? ` — dropped ${dropped} trailing user message${dropped === 1 ? "" : "s"}` : "")
      );
    } catch (error) {
      failed = true;
      console.error(`${plain(file)}: ${plain(error instanceof Error ? error.message : String(error))}`);
    }
  }
} finally {
  await service.dispose();
}
if (failed) process.exitCode = 1;
