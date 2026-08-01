import path from "node:path";
import { inlineValue, resolveImportProject, separatedValue } from "./import-project.js";
import { readImportBytes } from "./import-file.js";
import { terminalLineText as plain } from "../../shared/terminal-text.js";
import { createWorkerStoryApi } from "./worker-api.js";

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
  return { files, data, global };
}


export async function runStoryImport(
  argv: readonly string[],
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr
): Promise<void> {
  const command = parseImportCommand(argv);
  const project = await resolveImportProject(command);
  const backend = await createWorkerStoryApi({ dataDir: project.directory });
  let failed = false;
  try {
    for (const file of command.files) {
      try {
        const content = await readImportFile(file);
        const lowerFile = file.toLowerCase();
        const isStory = lowerFile.endsWith(".story");
        const isMarkdown = !isStory && (lowerFile.endsWith(".md")
          || (!lowerFile.endsWith(".jsonl") && content.trimStart().startsWith("#")));

        let title: string;
        let partsCount: number;
        let id: string;

        if (isStory) {
          const payload = await backend.api.importNovelAI(content);
          title = payload.title;
          partsCount = payload.nodes.length;
          id = payload.id;
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
          `${plain(file)}: imported "${plain(title)}" (${partsCount} parts) as ${id}\n`
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


