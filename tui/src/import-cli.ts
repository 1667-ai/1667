import { open } from "node:fs/promises";
import { MAX_IMPORT_BYTES } from "../../shared/types.js";
import {
  resolveProject,
  type ProjectRequest
} from "../../server/project-discovery.js";
import { PROJECT_DIRECTORY_NAME } from "../../server/project-layout.js";
import { createWorkerStoryApi } from "./worker-api.js";

/** The only source format this command reads. A second one gets its own name
 * here rather than a flag, so a file can never be read as the wrong format. */
export const IMPORT_SOURCES = ["sillytavern"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export interface ImportCommand {
  readonly source: ImportSource;
  readonly files: readonly string[];
  readonly data: string | null;
  readonly global: boolean;
}

export function parseImportCommand(argv: readonly string[]): ImportCommand {
  const source = argv[0];
  if (source === undefined) {
    throw new Error(`import needs a source: ${IMPORT_SOURCES.join(", ")}`);
  }
  if (!isImportSource(source)) {
    throw new Error(`unknown import source: ${source}`);
  }
  const files: string[] = [];
  let data: string | null = null;
  let global = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--global") global = true;
    else if (argument.startsWith("--data=")) data = inlineValue(argument, "--data");
    else if (argument === "--data") {
      const value = argv[++index];
      if (value === undefined || value.length === 0) {
        throw new Error("--data requires a value");
      }
      data = value;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown import option: ${argument}`);
    } else files.push(argument);
  }
  if (files.length === 0) throw new Error(`import ${source} needs a file`);
  if (global && data !== null) {
    throw new Error("--global and --data select different projects");
  }
  return { source, files, data, global };
}

/**
 * Read SillyTavern chat files into this project, one new story for each file.
 * Import creates stories and stops; it registers no watcher and keeps no
 * state, so this command has no counterpart that writes the file back.
 *
 * One unreadable file does not stop the others. The command reports each
 * failure and fails at the end, so a batch that partly succeeded still says so.
 */
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
  // Importing into a project that does not exist would create one, import into
  // it, and leave the starter stories it had just invented beside the result.
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
        const payload = await backend.api.importSillyTavern(await boundedRead(file));
        output.write(
          `${plain(file)}: imported "${plain(payload.title)}" `
            + `(${payload.path.length} parts) as ${payload.id}\n`
        );
      } catch (error) {
        failed = true;
        errorOutput.write(`${plain(file)}: ${plain(message(error))}\n`);
      }
    }
  } finally {
    await backend.dispose();
  }
  if (failed) throw new Error("import did not read every file");
}

/** Read one regular file, and stop at the limit rather than after it.
 *
 * Checking a size and then reading is two answers to one question: the file can
 * grow or be replaced in between. A FIFO or a pseudo-file reports no size at
 * all and then produces bytes without end. So the handle that is measured is
 * the handle that is read, it must be a regular file, and the read stops the
 * moment it crosses the limit instead of buffering everything first. */
async function boundedRead(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > MAX_IMPORT_BYTES) throw new Error(overLimit(info.size));
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream()) {
      const part = chunk as Buffer;
      bytes += part.byteLength;
      if (bytes > MAX_IMPORT_BYTES) throw new Error(overLimit(bytes));
      chunks.push(part);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

function overLimit(bytes: number): string {
  return `file is ${Math.round(bytes / 1e6)}MB — larger than the `
    + `${MAX_IMPORT_BYTES / 1e6}MB import limit`;
}

function isImportSource(value: string): value is ImportSource {
  return (IMPORT_SOURCES as readonly string[]).includes(value);
}

function projectRequest(command: ImportCommand): ProjectRequest {
  return {
    cwd: process.cwd(),
    ...(command.data === null ? {} : { data: command.data }),
    ...(command.global ? { global: true } : {})
  };
}

/** A file name and a story title both come from outside. Neither may carry a
 * terminal control sequence into this report. */
function plain(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/gu, "");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inlineValue(argument: string, flag: string): string {
  const value = argument.slice(flag.length + 1);
  if (value.length === 0) throw new Error(`${flag} requires a value`);
  return value;
}
