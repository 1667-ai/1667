import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * An exported `.md` is a hand-off artifact 1667 never reads back. It
 * carries no anchors and no state, so writing one is the whole feature.
 */
export interface StoryExportRequest {
  readonly directory: string;
  readonly title: string;
  readonly markdown: string;
  /** Overwrite the unsuffixed name instead of picking the next free one. */
  readonly force?: boolean;
}

export async function writeStoryExport(
  request: StoryExportRequest
): Promise<string> {
  const base = exportFileBase(request.title);
  if (request.force === true) {
    const file = resolve(request.directory, `${base}.md`);
    await writeFile(file, request.markdown, { encoding: "utf8", flag: "w" });
    return file;
  }
  const file = await availablePath(request.directory, base);
  await writeFile(file, request.markdown, { encoding: "utf8", flag: "wx" });
  return file;
}

export function exportFileBase(title: string): string {
  let name = title.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim() || "story";
  // Stay well under the 255-byte filesystem component limit, leaving room
  // for the "-<n>.md" collision suffix.
  const encoder = new TextEncoder();
  while (encoder.encode(name).length > 120) name = [...name].slice(0, -1).join("").trimEnd();
  return name || "story";
}

/** Never clobber an existing export: story.md, story-2.md, story-3.md, … */
async function availablePath(directory: string, base: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = resolve(
      directory,
      attempt === 1 ? `${base}.md` : `${base}-${attempt}.md`
    );
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
}
