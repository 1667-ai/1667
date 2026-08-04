import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(
  new URL("../scripts/check-commit-attribution.ts", import.meta.url)
);

/** Run the checker exactly as CI does, and report what a person would see. */
function runChecker(args: readonly string[], repo: string): {
  readonly code: number;
  readonly output: string;
} {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", CHECKER, "--repo", repo, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`
    };
  }
}

/** A throwaway repository, so the check runs against real git objects rather
 *  than against a hand-built record. */
function createRepository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "1667-attribution-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "A Writer");
  git("config", "user.email", "writer@example.com");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git("add", "seed.txt");
  git("commit", "--quiet", "-m", "chore: seed");
  return root;
}

function commit(root: string, message: string, options: {
  readonly authorName?: string;
  readonly authorEmail?: string;
} = {}): void {
  const file = path.join(root, `part-${Math.abs(hash(message))}.txt`);
  writeFileSync(file, message);
  execFileSync("git", ["add", "-A"], { cwd: root });
  const args = ["commit", "--quiet", "-m", message];
  if (options.authorName !== undefined) {
    args.push("--author", `${options.authorName} <${options.authorEmail ?? ""}>`);
  }
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function hash(value: string): number {
  let total = 0;
  for (const char of value) total = (total * 31 + char.codePointAt(0)!) | 0;
  return total;
}

test("a commit that names no tool passes", () => {
  const root = createRepository();
  try {
    commit(root, "feat(story): add a chapter break");
    const result = runChecker(["--range", "HEAD~1..HEAD"], root);
    assert.equal(result.code, 0);
    assert.match(result.output, /clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Co-Authored-By trailer that names Claude is refused", () => {
  const root = createRepository();
  try {
    commit(
      root,
      "feat(story): add a chapter break\n\n"
        + "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>\n"
    );
    const result = runChecker(["--range", "HEAD~1..HEAD"], root);
    assert.equal(result.code, 1);
    assert.match(result.output, /Co-Authored-By trailer names an AI tool/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commit authored as Claude is refused", () => {
  const root = createRepository();
  try {
    commit(root, "docs: record the roadmap", {
      authorName: "Claude",
      authorEmail: "noreply@anthropic.com"
    });
    const result = runChecker(["--range", "HEAD~1..HEAD"], root);
    assert.equal(result.code, 1);
    assert.match(result.output, /author names an AI tool/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a personal GitHub noreply address stays allowed", () => {
  const root = createRepository();
  try {
    commit(root, "fix(tui): keep the caret on screen", {
      authorName: "10fra",
      authorEmail: "743893+10fra@users.noreply.github.com"
    });
    const result = runChecker(["--range", "HEAD~1..HEAD"], root);
    assert.equal(result.code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Claude-Session trailer stays allowed, because it is not co-authorship", () => {
  const root = createRepository();
  try {
    commit(
      root,
      "fix(tui): keep the caret on screen\n\n"
        + "Claude-Session: https://claude.ai/code/session_01ABC\n"
    );
    const result = runChecker(["--range", "HEAD~1..HEAD"], root);
    assert.equal(result.code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prose that mentions Claude outside a trailer stays allowed", () => {
  const root = createRepository();
  try {
    commit(
      root,
      "docs(model-providers): explain how Claude handles a prompt cache\n\n"
        + "The Anthropic transport reuses a cache breakpoint here.\n"
    );
    const result = runChecker(["--range", "HEAD~1..HEAD"], root);
    assert.equal(result.code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a range with many commits reports every refusal", () => {
  const root = createRepository();
  try {
    commit(root, "feat: one\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n");
    commit(root, "feat: two");
    commit(root, "feat: three\n\nCo-Authored-By: Codex <noreply@openai.com>\n");
    const result = runChecker(["--range", "HEAD~3..HEAD"], root);
    assert.equal(result.code, 1);
    const refusals = result.output.match(/names an AI tool/g) ?? [];
    assert.equal(refusals.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the message mode refuses a trailer before the commit exists", () => {
  const root = createRepository();
  try {
    const messagePath = path.join(root, "COMMIT_EDITMSG");
    writeFileSync(
      messagePath,
      "feat: add a take\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n"
    );
    const result = runChecker(["--message", messagePath], root);
    assert.equal(result.code, 1);
    assert.match(result.output, /Co-Authored-By trailer names an AI tool/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commit message cannot hide a trailer by forging the separators", () => {
  const root = createRepository();
  try {
    // The checker reads git's output with the ASCII unit and record
    // separators. A message that contains them must not be able to end its
    // own record and carry a trailer into the part that follows.
    const unit = "\u001f";
    const record = "\u001e";
    commit(
      root,
      `feat: sneaky\n\npadding${unit}still the message${record}`
        + `${"0".repeat(40)}${unit}Someone${unit}someone@example.com\n\n`
        + "Co-Authored-By: Claude <noreply@anthropic.com>\n"
    );
    const result = runChecker(["--range", "HEAD~1..HEAD"], root);
    assert.equal(result.code, 1);
    assert.match(result.output, /Co-Authored-By trailer names an AI tool/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
