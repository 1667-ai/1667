import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { MAX_IMPORT_BYTES } from "../../shared/types.js";
import {
  resolveProject,
  type ProjectRequest
} from "../../server/project-discovery.js";
import { PROJECT_DIRECTORY_NAME } from "../../server/project-layout.js";
import { noFollowFlag } from "../../server/data-directory-file-read.js";
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
    else if (argument === "--data") {
      const value = argv[++index];
      if (value === undefined || value.length === 0) {
        throw new Error(`${argument} requires a value`);
      }
      data = value;
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown import option: ${argument}`);
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

/** Strip terminal control characters from untrusted file names and titles. */
function plain(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
}

export async function runStoryImport(
  argv: readonly string[],
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr
): Promise<void> {
  const command = parseImportCommand(argv);
  const outcome = await resolveProject(projectRequest(command));
  if (outcome.kind === "absent") {
    throw new Error(
      `no ${PROJECT_DIRECTORY_NAME} story project in ${outcome.cwd} or any parent, `
        + "so there is nowhere to import. Run '1667 init' first."
    );
  }
  const project = outcome.project;
  if (!project.exists) {
    throw new Error(
      `${project.directory} is not a 1667 story project yet, so there is `
        + "nowhere to import. Run '1667 init' there first."
    );
  }
  const backend = await createWorkerStoryApi({ dataDir: project.directory });
  let failed = false;
  try {
    for (const file of command.files) {
      try {
        const content = await readImportFile(file);
        const lowerFile = file.toLowerCase();
        const isMarkdown = lowerFile.endsWith(".md")
          || (!lowerFile.endsWith(".jsonl") && content.trimStart().startsWith("#"));

        let title: string;
        let partsCount: number;
        let id: string;

        if (isMarkdown) {
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
  let handle: FileHandle | undefined;
  try {
    // O_NONBLOCK makes opening a FIFO return immediately; the retained handle's
    // metadata then rejects every non-regular source before any content read.
    handle = await open(
      file,
      constants.O_RDONLY
        | (process.platform === "win32" ? 0 : constants.O_NONBLOCK)
        | noFollowFlag()
    );
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("import source is not a regular file");
    if (info.size > MAX_IMPORT_BYTES) {
      throw new Error(
        `file is ${Math.round(info.size / 1e6)}MB — larger than the `
          + `${MAX_IMPORT_BYTES / 1e6}MB import limit`
      );
    }
    const bytes = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const result = await handle.read(bytes, total, bytes.length - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (total !== info.size) throw new Error("import source changed size while being read");
    return bytes.subarray(0, total).toString("utf8");
  } finally {
    await handle?.close();
  }
}

function projectRequest(command: ImportCommand): ProjectRequest {
  return {
    cwd: process.cwd(),
    ...(command.data === null ? {} : { data: command.data }),
    ...(command.global ? { global: true } : {})
  };
}

function inlineValue(argument: string, flag: string): string {
  const value = argument.slice(flag.length + 1);
  if (value.length === 0) throw new Error(`${flag} requires a value`);
  return value;
}
