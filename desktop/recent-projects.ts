import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopRecentProject } from "./shell-contract.js";

const MAX_RECENT_PROJECTS = 12;

export interface RecentProjectsStore {
  list(): Promise<readonly DesktopRecentProject[]>;
  remember(project: DesktopRecentProject): Promise<readonly DesktopRecentProject[]>;
  remove(directory: string): Promise<readonly DesktopRecentProject[]>;
}

/** Small private store for the Shell's project picker. */
export class FileRecentProjectsStore implements RecentProjectsStore {
  constructor(
    private readonly file: string,
    private readonly maxEntries = MAX_RECENT_PROJECTS
  ) {}

  async list(): Promise<readonly DesktopRecentProject[]> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      return decodeRecentProjects(raw).slice(0, this.maxEntries);
    } catch {
      return [];
    }
  }

  async remember(
    project: DesktopRecentProject
  ): Promise<readonly DesktopRecentProject[]> {
    const existing = await this.list();
    const next = [
      project,
      ...existing.filter((entry) => entry.directory !== project.directory)
    ].slice(0, this.maxEntries);
    await this.write(next);
    return next;
  }

  async remove(directory: string): Promise<readonly DesktopRecentProject[]> {
    const next = (await this.list()).filter((entry) => entry.directory !== directory);
    await this.write(next);
    return next;
  }

  private async write(projects: readonly DesktopRecentProject[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = path.join(
      path.dirname(this.file),
      "." + path.basename(this.file) + "." + randomUUID() + ".tmp"
    );
    try {
      await writeFile(temporary, JSON.stringify(projects) + "\n", {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function decodeRecentProjects(value: unknown): DesktopRecentProject[] {
  if (!Array.isArray(value)) return [];
  const projects: DesktopRecentProject[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.root !== "string"
      || typeof record.directory !== "string"
      || typeof record.openedAt !== "number"
      || !Number.isFinite(record.openedAt)
      || !path.isAbsolute(record.root)
      || !path.isAbsolute(record.directory)) {
      continue;
    }
    projects.push({
      root: record.root,
      directory: record.directory,
      openedAt: record.openedAt
    });
  }
  return projects;
}
