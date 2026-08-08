import path from "node:path";
import { readImportBytes } from "./import-file.js";
import { resolveMachineTierRoot } from "./machine-tier.js";
import { InternalErrorReporter } from "./internal-error-reporter.js";
import { terminalLineText as plain } from "../shared/terminal-text.js";
import { fidelityReport } from "../shared/fidelity.js";
import { StoryService } from "./story-service.js";
import { sillyTavernFidelity } from "./import-st.js";

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error("Usage: npm run import -- <file...>");
  process.exit(1);
}


const machineDir = await resolveMachineTierRoot();
const errorReporter = await InternalErrorReporter.open(machineDir);
const service = new StoryService({
  machineDir,
  errorReporter,
  settingsActivation: "recover-only"
});
await service.init();
let failed = false;
try {
  for (const file of files) {
    try {
      // The same reader the packaged commands use, so this script cannot
      // accept a symlink, a FIFO, or a file that grows while it is read.
      const content = new TextDecoder("utf-8").decode(await readImportBytes(file));
      const lowerFile = file.toLowerCase();
      const isStory = lowerFile.endsWith(".story");
      const isMarkdown = !isStory && (lowerFile.endsWith(".md")
        || (!lowerFile.endsWith(".jsonl") && content.trimStart().startsWith("#")));

      let title: string;
      let partsCount: number;
      let id: string;
      let fidelity: readonly string[] | null = null;

      if (isStory) {
        const imported = await service.importNovelAIWithReport(content);
        title = imported.payload.title;
        partsCount = imported.payload.nodes.length;
        id = imported.payload.id;
        fidelity = imported.fidelity;
      } else if (isMarkdown) {
        const defaultTitle = path.basename(file, path.extname(file));
        const imported = await service.importMarkdownWithReport(content, { defaultTitle });
        title = imported.payload.title;
        partsCount = imported.payload.nodes.length;
        id = imported.payload.id;
      } else {
        const imported = await service.importSillyTavernWithReport(content);
        title = imported.payload.title;
        partsCount = imported.payload.nodes.length;
        id = imported.payload.id;
        fidelity = sillyTavernFidelity(imported);
      }

      if (fidelity !== null) console.error(`${plain(file)}: ${plain(fidelityReport(fidelity))}`);
      console.log(`${plain(file)}: imported "${plain(title)}" (${partsCount} parts) as ${id}`);
    } catch (error) {
      failed = true;
      console.error(`${plain(file)}: ${plain(error instanceof Error ? error.message : String(error))}`);
    }
  }
} finally {
  await service.dispose();
  await errorReporter.close();
}
if (failed) process.exitCode = 1;
