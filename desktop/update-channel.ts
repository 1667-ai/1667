import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type DesktopUpdateChannel = "stable" | "beta";

/** Store the selected update channel in the private machine tier. */
export class FileUpdateChannelStore {
  constructor(private readonly file: string) {}

  async read(): Promise<DesktopUpdateChannel> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      if (isRecord(value) && (value.channel === "stable" || value.channel === "beta")) {
        return value.channel;
      }
    } catch {
      // A missing or damaged preference falls back to the safe stable channel.
    }
    return "stable";
  }

  async write(channel: DesktopUpdateChannel): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = path.join(
      path.dirname(this.file),
      `.${path.basename(this.file)}.${randomUUID()}.tmp`
    );
    try {
      await writeFile(temporary, JSON.stringify({ channel }) + "\n", {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
