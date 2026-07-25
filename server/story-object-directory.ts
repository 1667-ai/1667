import {
  constants,
  type Stats
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import {
  noFollowFlag,
  requireSameFileIdentity
} from "./data-directory-file-read.js";
import { StoryFormatError } from "./story-format-facts.js";

const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;

export class RetainedStoryObjectDirectory {
  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
    private readonly identity: Stats,
    private readonly label: string
  ) {}

  static async open(directory: string, label: string): Promise<RetainedStoryObjectDirectory> {
    const pathInfo = await lstat(directory);
    requireDirectory(pathInfo, label);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        directory,
        constants.O_RDONLY | DIRECTORY_FLAG | noFollowFlag()
      );
      const handleInfo = await handle.stat();
      requireDirectory(handleInfo, label);
      requireSameFileIdentity(pathInfo, handleInfo, directory);
      return new RetainedStoryObjectDirectory(
        directory,
        handle,
        handleInfo,
        label
      );
    } catch (error) {
      await handle?.close();
      throw error;
    }
  }

  async child(
    name: string,
    create: boolean,
    label: string
  ): Promise<RetainedStoryObjectDirectory> {
    if (path.basename(name) !== name || name === "." || name === "..") {
      throw new StoryFormatError(`Unsafe story object directory name: ${name}`);
    }
    await this.revalidate();
    const childPath = path.join(this.path, name);
    if (create) {
      await mkdir(childPath).catch((error: unknown) => {
        if (!isErrorCode(error, "EEXIST")) throw error;
      });
    }
    const child = await RetainedStoryObjectDirectory.open(childPath, label);
    try {
      await this.revalidate();
      return child;
    } catch (error) {
      await child.close();
      throw error;
    }
  }

  async revalidate(): Promise<void> {
    const [pathInfo, handleInfo] = await Promise.all([
      lstat(this.path),
      this.handle.stat()
    ]);
    requireDirectory(pathInfo, this.label);
    requireDirectory(handleInfo, this.label);
    requireSameFileIdentity(this.identity, handleInfo, this.path);
    requireSameFileIdentity(handleInfo, pathInfo, this.path);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

function requireDirectory(info: Stats, label: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new StoryFormatError(`${label} is not a retained no-follow directory`);
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
