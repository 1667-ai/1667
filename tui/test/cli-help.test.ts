import { expect, test } from "bun:test";
import {
  AUTH_HELP,
  EXPORT_HELP,
  HELP,
  INIT_HELP,
  IMPORT_CARD_HELP,
  IMPORT_HELP,
  IMPORT_LOREBOOK_HELP,
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
  for (const command of ["init", "auth", "export", "import", "import-card", "import-lorebook"]) {
    expect(`${command}:${HELP.includes(command)}`).toBe(`${command}:true`);
    expect(commandHelp(command)).not.toBe(null);
  }
  expect(commandHelp("no-such-command")).toBe(null);
});

test("the front page sends the reader to the page that holds the detail", () => {
  expect(HELP).toContain("1667 <command> --help");
});

test("each command page opens with its own usage line", () => {
  const pages: ReadonlyArray<readonly [string, string]> = [
    ["1667 init", INIT_HELP],
    ["1667 auth", AUTH_HELP],
    ["1667 export", EXPORT_HELP],
    ["1667 import", IMPORT_HELP],
    ["1667 import-card", IMPORT_CARD_HELP],
    ["1667 import-lorebook", IMPORT_LOREBOOK_HELP]
  ];
  for (const [command, page] of pages) {
    const usage = page.split("\n").find((line) => line.startsWith("Usage:"));
    expect(`${command}:${usage !== undefined && usage.includes(command)}`)
      .toBe(`${command}:true`);
  }
});

test("a command that requires a story says so on its own page", () => {
  for (const page of [IMPORT_CARD_HELP, IMPORT_LOREBOOK_HELP]) {
    expect(page).toContain("--story");
    expect(page).toContain("required");
  }
});

test("the front page does not send the reader to a page that does not exist", () => {
  // Every command named on the front page must answer --help, or the pointer
  // sends a confused reader into an unknown-option error. `serve` and `upgrade`
  // answer it themselves, so they are excluded here and covered by their own
  // commands.
  for (const command of ["init", "export", "import", "import-card", "import-lorebook", "auth"]) {
    expect(`${command}:${commandHelp(command) !== null}`).toBe(`${command}:true`);
  }
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
  expect(wantsHelp(["--story", "x", "--help"])).toBeTrue();
  expect(wantsHelp(["book.md"])).toBeFalse();
  expect(wantsHelp([])).toBeFalse();
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
  expect(output).toContain("1667 import-lorebook — add NovelAI lorebook Facts");
  expect(output).toContain("1667 export — write a story to a file");
  expect(output).not.toContain("unknown import option");
});
