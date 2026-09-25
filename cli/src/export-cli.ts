import type { ExportFormat } from "../../host/launcher-export.js";
import { exportStories } from "../../host/launcher-export.js";
import { fidelityReport } from "../../shared/fidelity.js";
import { inlineValue, resolveExistingProject, separatedValue } from "./project-command.js";
import { openProjectBackend } from "./vault-project-backend.js";

export type { ExportFormat } from "../../host/launcher-export.js";

export interface ExportCommand {
  readonly storyId: string | null;
  readonly all: boolean;
  readonly format: ExportFormat;
  readonly force: boolean;
  readonly data: string | null;
  readonly global: boolean;
  readonly passphraseFile: string | null;
}

export function parseExportCommand(argv: readonly string[]): ExportCommand {
  let storyId: string | null = null;
  let all = false;
  let format: ExportFormat = "markdown";
  let force = false;
  let data: string | null = null;
  let global = false;
  let passphraseFile: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--force") force = true;
    else if (argument === "--all") all = true;
    else if (argument === "--global") global = true;
    else if (argument.startsWith("--passphrase-file=")) {
      passphraseFile = inlineValue(argument, "--passphrase-file");
    }
    else if (argument.startsWith("--story=")) storyId = inlineValue(argument, "--story");
    else if (argument.startsWith("--data=")) data = inlineValue(argument, "--data");
    else if (argument.startsWith("--format=")) format = archiveFormat(inlineValue(argument, "--format"));
    else if (argument === "--story" || argument === "--data" || argument === "--format"
      || argument === "--passphrase-file") {
      const value = separatedValue(argv, ++index, argument);
      if (argument === "--story") storyId = value;
      else if (argument === "--data") data = value;
      else if (argument === "--passphrase-file") passphraseFile = value;
      else format = archiveFormat(value);
    } else throw new Error(`unknown export option: ${argument}`);
  }
  if (global && data !== null) throw new Error("--global and --data select different projects");
  if (all && storyId !== null) throw new Error("--story and --all select different stories");
  return { storyId, all, format, force, data, global, passphraseFile };
}

export async function runStoryExport(
  argv: readonly string[],
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr
): Promise<void> {
  const command = parseExportCommand(argv);
  const project = await resolveExistingProject(command, "export");
  const backend = await openProjectBackend(project, command.passphraseFile);
  try {
    await exportStories({
      api: backend.api,
      directory: project.root,
      errorDirectory: project.directory,
      storyId: command.storyId,
      all: command.all,
      format: command.format,
      force: command.force,
      onResult: (result) => {
        output.write(`${result.file}\n`);
        if (result.fidelity.length > 0 || command.format !== "markdown") {
          errorOutput.write(`${result.file}: ${fidelityReport(result.fidelity)}\n`);
        }
      }
    });
  } finally {
    await backend.dispose();
  }
}

function archiveFormat(value: string): Exclude<ExportFormat, "markdown"> {
  if (value === "story" || value === "scenario" || value === "lorebook") return value;
  throw new Error(`unknown export format: ${value}`);
}
