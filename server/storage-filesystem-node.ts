import { statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FilesystemInfo } from "./storage-filesystem.js";

const execFileAsync = promisify(execFile);

export async function filesystemInfo(directory: string): Promise<FilesystemInfo> {
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/sbin/mount", [], {
      encoding: "utf8",
      timeout: 5_000
    });
    return darwinMountInfo(directory, stdout);
  }
  return { type: (await statfs(directory, { bigint: true })).type };
}

export function darwinMountInfo(directory: string, mounts: string): FilesystemInfo {
  let selected: { mountPoint: string; typeName: string; local: boolean } | null = null;
  for (const line of mounts.split("\n")) {
    const match = /^.+ on (.+) \(([^,()]+)(?:, ([^()]*))?\)$/.exec(line);
    if (match === null) continue;
    const mountPoint = match[1]!.replaceAll("\\040", " ");
    if (directory !== mountPoint && !directory.startsWith(mountPoint === "/" ? "/" : `${mountPoint}/`)) continue;
    if (selected !== null && selected.mountPoint.length >= mountPoint.length) continue;
    const options = new Set((match[3] ?? "").split(", "));
    selected = { mountPoint, typeName: match[2]!.toLowerCase(), local: options.has("local") };
  }
  if (selected === null) throw new Error(`Could not identify the data-directory mount: ${directory}`);
  return { type: 0n, typeName: selected.typeName, local: selected.local };
}
