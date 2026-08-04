/**
 * Child-process fixture for private-file-publication-frozen-writer.test.ts.
 * Runs one unmodified `publishPrivateFileNoReplace` call and reports its
 * outcome over IPC, so the parent can `SIGSTOP` it mid-publish and prove a
 * concurrent recovery pass leaves a live writer alone.
 */
import { publishPrivateFileNoReplace } from "../server/private-file-publication.js";

const file = process.argv[2]!;
const policy = { label: "frozen-writer fixture file", maxBytes: 4096 };
const bytes = Buffer.from('{"probe":true}', "utf8");

process.send?.({ ready: true });
try {
  await publishPrivateFileNoReplace(file, bytes, policy);
  process.send?.({ outcome: "published" });
} catch (error) {
  process.send?.({
    outcome: "failed",
    code: (error as NodeJS.ErrnoException).code ?? null,
    message: error instanceof Error ? error.message : String(error)
  });
}
