import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  AUTH_HELP,
  HELP,
  INIT_HELP,
  commandHelp,
  wantsHelp
} from "../src/cli-help.js";

/** A short terminal is 24 rows. The front page has to fit one so the usage
 * lines stay on screen, which is the whole reason it is a map and not a manual. */
const SHORT_TERMINAL_ROWS = 24;

test("the front page fits a short terminal and keeps usage above the fold", () => {
  const lines = HELP.split("\n");
  expect(lines.length <= SHORT_TERMINAL_ROWS).toBeTrue();

  // Usage must be readable without scrolling on the shortest terminal we claim
  // to fit, so it cannot drift down the page as commands are added.
  const usage = lines.findIndex((line) => line.startsWith("Usage:"));
  expect(usage >= 0).toBeTrue();
  expect(usage < 12).toBeTrue();
});

test("the front page names every command that has its own page", () => {
  for (const command of ["init", "encrypt", "decrypt", "auth", "export", "import", "import-card", "import-lorebook"]) {
    expect(`${command}:${HELP.includes(command)}`).toBe(`${command}:true`);
    expect(commandHelp(command)).not.toBe(null);
  }
  expect(commandHelp("no-such-command")).toBe(null);
});

test("a command page does not advertise a form its parser refuses", () => {
  // `auth show` needs exactly one of --url and --auth-file, and --url always
  // takes a value. The page said both were optional and that --url could be
  // bare, which is the app-level flag, not this one.
  expect(AUTH_HELP).toContain("(--url <base-url> | --auth-file <path>)");
  expect(AUTH_HELP).toContain("exactly one");
  expect(AUTH_HELP).not.toContain("bare");
  // `--from` is only legal with --adopt.
  expect(INIT_HELP).toContain("requires --adopt");
});

test("an inherited object key is not a command", () => {
  // A plain object answers for every prototype key, so `1667 constructor
  // --help` printed the native Function text and exited as if it had helped.
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    expect(`${key}:${commandHelp(key)}`).toBe(`${key}:null`);
  }
});

test("help is recognised before a command parser could refuse it", () => {
  // `1667 import --help` used to report an unknown option, because the command
  // parser saw the flag first.
  expect(wantsHelp(["--help"])).toBeTrue();
  expect(wantsHelp(["-h"])).toBeTrue();
  expect(wantsHelp(["book.md"])).toBeFalse();
  expect(wantsHelp([])).toBeFalse();

  // `--data` and `--from` take the next argument whatever it looks like, so a
  // later flag may be a value rather than a question.
  expect(wantsHelp(["--data", "-h"])).toBeFalse();
  expect(wantsHelp(["--data", "--help"])).toBeFalse();
});

test("1667 <command> --help prints that command's page instead of refusing the flag", async () => {
  const { main } = await import("../src/main.js");
  const original = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  process.stdout.write = ((chunk: string) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await main(["import", "--help"]);
    await main(["import-lorebook", "--help"]);
    await main(["export", "-h"]);
  } finally {
    process.stdout.write = original;
  }
  const output = captured.join("");
  expect(output).toContain("1667 import — make a new story from a file");
  expect(output).toContain("1667 import-lorebook — add lorebook Facts");
  expect(output).toContain("1667 export — write a story to a file");
  expect(output).not.toContain("unknown import option");
});

test("CLI errors cannot write terminal control characters", () => {
  const moduleUrl = new URL("../src/main.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, [
    "--eval",
    `import { runCli } from ${JSON.stringify(moduleUrl)};`
      + "await runCli(['--unknown\\u001b[31m']);"
  ], {
    encoding: "utf8",
    // Cold-starting the CLI imports the whole app graph; on a contended
    // runner that can take seconds. Only a hang should kill the child.
    timeout: 15_000
  });

  expect(child.status).toBe(2);
  expect(child.stderr).toContain("unknown option: --unknown▪[31m");
  expect(child.stderr).not.toContain("\u001b");
});
