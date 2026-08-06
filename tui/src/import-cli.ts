import path from "node:path";
import { inlineValue, resolveExistingProject, separatedValue } from "./project-command.js";
import { readImportBytes } from "../../server/import-file.js";
import { terminalLineText as plain } from "../../shared/terminal-text.js";
import { createWorkerStoryApi } from "./worker-api.js";
import { fidelityReport } from "../../shared/fidelity.js";

export interface ImportCommand {
  readonly files: readonly string[];
  readonly data: string | null;
  readonly global: boolean;
}

export function parseImportCommand(argv: readonly string[]): ImportCommand {
  const files: string[] = [];
  let data: string | null = null;
  let global = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--global") global = true;
    else if (argument.startsWith("--data=")) data = inlineValue(argument, "--data");
    else if (argument === "--data") data = separatedValue(argv, ++index, argument); else if (argument.startsWith("-")) {
      throw new Error(`unknown import option: ${plain(argument)}`);
    } else {
      files.push(argument);
    }
  }
  if (global && data !== null) {
    throw new Error("--global and --data select different projects");
  }
  if (files.length === 0) {
    throw new Error("import requires at least one file argument");
  }
  for (const file of files) {
    if (file.toLowerCase().endsWith(".lorebook")) {
      throw new Error("1667 import creates stories, not Lorebooks (.lorebook); use 1667 import-lorebook");
    }
  }
  return { files, data, global };

}


export async function runStoryImport(
  argv: readonly string[],
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr
): Promise<void> {
  const command = parseImportCommand(argv);
  const project = await resolveExistingProject(command, "import");
  const backend = await createWorkerStoryApi({ dataDir: project.directory });
  let failed = false;
  try {
    for (const file of command.files) {
      try {
        const content = await readImportFile(file);
        const lowerFile = file.toLowerCase();
        const isStory = lowerFile.endsWith(".story");
        const isScenario = lowerFile.endsWith(".scenario");
        const isMarkdown = !isStory && !isScenario && (lowerFile.endsWith(".md")
          || (!lowerFile.endsWith(".jsonl") && content.trimStart().startsWith("#")));

        let title: string;
        let partsCount: number;
        let factsCount: number | null = null;
        let id: string;

        if (isStory) {
          const { payload, fidelity } = await backend.api.importNovelAI(content);
          title = payload.title;
          partsCount = payload.nodes.length;
          factsCount = payload.facts.length;
          id = payload.id;
          errorOutput.write(`${plain(file)}: ${fidelityReport(fidelity)}\n`);
        } else if (isScenario) {
          const { payload, fidelity } = await backend.api.importScenario(content);
          title = payload.title;
          partsCount = payload.nodes.length;
          factsCount = payload.facts.length;
          id = payload.id;
          errorOutput.write(`${plain(file)}: ${fidelityReport(fidelity)}\n`);
        } else if (isMarkdown) {
          const defaultTitle = path.basename(file, path.extname(file));
          const payload = await backend.api.importMarkdown(content, defaultTitle);
          title = payload.title;
          partsCount = payload.nodes.length;
          id = payload.id;
        } else {
          const payload = await backend.api.importSillyTavern(content);
          title = payload.title;
          partsCount = payload.nodes.length;
          id = payload.id;
        }

        output.write(
          `${plain(file)}: imported "${plain(title)}" (${partsCount} parts`
            + `${factsCount === null ? "" : `, ${factsCount} facts`}) as ${id}\n`
        );
      } catch (error) {
        failed = true;
        errorOutput.write(`${plain(file)}: ${plain(error instanceof Error ? error.message : String(error))}\n`);
      }
    }
  } finally {
    await backend.dispose();
  }
  if (failed) process.exitCode = 1;
}

async function readImportFile(file: string): Promise<string> {
  return new TextDecoder("utf-8").decode(await readImportBytes(file));
}
