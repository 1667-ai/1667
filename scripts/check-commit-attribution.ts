/** Runs the commit attribution check over a range of commits, or over one
 *  message file.
 *
 *  Usage:
 *    tsx scripts/check-commit-attribution.ts --range <base>..<head>
 *    tsx scripts/check-commit-attribution.ts --message <path>
 *
 *  Add `--repo <path>` to read a repository other than the working directory.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  refusalReport,
  refuseAttribution,
  refuseMessageAttribution,
  type AttributionRefusal,
  type CommitAttribution
} from "./commit-attribution.js";

/** Read every commit in the range.
 *
 *  A commit message is free-form text, so no delimiter is safe to parse it
 *  with: a crafted message can always reproduce whatever separator the reader
 *  expects and hide a trailer in the part that follows. So nothing untrusted
 *  is ever split. The sha list cannot be forged, and each commit's identity
 *  fields and message are then read in their own calls, where the whole
 *  output is the value. */
function readRange(range: string, repo: string | undefined): CommitAttribution[] {
  const at = repo === undefined ? [] : ["-C", repo];
  const run = (args: readonly string[]): string => execFileSync(
    "git",
    [...at, ...args],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  );
  const shas = run(["log", "--format=%H", range])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{40}$/.test(line));
  return shas.map((sha) => {
    // %x1f separates only fields that git itself controls; an identity can
    // hold no separator, so this split is safe where a message split is not.
    const identity = run(["show", "-s", "--format=%an%x1f%ae%x1f%cn%x1f%ce", sha])
      .replace(/\n$/, "")
      .split("\u001f");
    return {
      sha,
      authorName: identity[0] ?? "",
      authorEmail: identity[1] ?? "",
      committerName: identity[2] ?? "",
      committerEmail: identity[3] ?? "",
      message: run(["show", "-s", "--format=%B", sha])
    };
  });
}

function main(): void {
  const argv = process.argv.slice(2);
  const rangeAt = argv.indexOf("--range");
  const messageAt = argv.indexOf("--message");
  const repoAt = argv.indexOf("--repo");
  const repo = repoAt >= 0 ? argv[repoAt + 1] : undefined;
  let refusals: AttributionRefusal[] = [];

  if (messageAt >= 0) {
    const path = argv[messageAt + 1];
    if (path === undefined) throw new Error("--message needs a path");
    refusals = refuseMessageAttribution(readFileSync(path, "utf8"));
  } else if (rangeAt >= 0) {
    const range = argv[rangeAt + 1];
    if (range === undefined) throw new Error("--range needs a revision range");
    refusals = readRange(range, repo).flatMap(refuseAttribution);
  } else {
    throw new Error("give --range <base>..<head> or --message <path>");
  }

  if (refusals.length === 0) {
    process.stdout.write("commit attribution: clean\n");
    return;
  }
  process.stderr.write(refusalReport(refusals));
  process.exitCode = 1;
}

main();
