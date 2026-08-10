import { readFile } from "node:fs/promises";
import path from "node:path";

export interface AssertExactOptions {
  /** Repository root the artifact path is reported relative to. */
  readonly root: string;
  /** What the artifact holds, for example "story schema" or "release notes". */
  readonly label: string;
  /** The exact command a reader should run to regenerate the artifact. Each
   *  script keeps its own accurate remediation text here rather than all
   *  four collapsing to one shared string. */
  readonly writeCommand: string;
}

/**
 * Compare a generated artifact on disk against the bytes it should hold.
 * Shared by every `--check` mode in `scripts/*-schema.ts` and
 * `scripts/release-notes.ts`, so the missing/stale error shape and the
 * comparison itself stay in one place.
 */
export async function assertExact(
  file: string,
  expected: string,
  options: AssertExactOptions
): Promise<void> {
  const relative = path.relative(options.root, file);
  let actual: string;
  try {
    actual = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Generated ${options.label} artifact is missing: ${relative}`, { cause: error });
  }
  if (actual !== expected) {
    throw new Error(
      `Generated ${options.label} artifact is stale: ${relative}; run ${options.writeCommand}`
    );
  }
}
