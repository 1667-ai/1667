/** Command-line help, one page per command.
 *
 * The front page must fit a small terminal. A writer who cannot see the usage
 * lines cannot find the command they wanted, so detail lives on the page of the
 * command it belongs to and the front page stays a map. */

export const HELP = `1667 — a full-screen terminal environment for writing fiction

Stories live in .1667/ beside your writing, found by walking up from the
current directory the way git finds .git.

Usage: 1667 [options]
       1667 <command> [options]

Commands:
  init             Make a project in this directory
  export           Write a story to Markdown or a NovelAI archive
  import           Make a new story from a file
  import-card      Add Facts from a character card to a story that exists
  import-lorebook  Add Facts from a NovelAI lorebook to a story that exists
  serve            Run the HTTP server
  auth             Show an access record
  upgrade          Update this program

Options:
  --story <id>       Open this story instead of the most recently updated
  --data <path>      Open this project root instead of discovering one
  --global           Open the machine-wide project instead of a folder
  --url [base-url]   Connect to a loopback 1667 HTTP server; bare reads run.json
  --auth-file <path> Use the canonical private auth record for --url
  --demo             Use the in-memory lantern keeper fixture
  -h, --help         Show help
  --version [--json] Print embedded build identity

Development options: --embedded, --diagnostic, --print-logs, --render-once,
--size, --keys, --debug-density.

Run '1667 <command> --help' for what one command accepts.`;

export const EXPORT_HELP = `1667 export — write a story to a file

Usage: 1667 export [--story <id>|--all] [--format story|scenario|lorebook]
                   [--force] [--data <path>|--global]

Writes Markdown by default. It contains one story's selected line — the take
chosen at each part, as you last left it. Prose only: chapters become '##'
headings; directions and unchosen takes stay behind. No option picks the line,
so choose it in the app first.

Use --format for a NovelAI archive: story, scenario, or lorebook. The command
reports archive fidelity limits on standard error.

The command writes the path of each file to standard output. It never replaces
an existing file (story.md, story-2.md, …) unless you use --force.

Options:
  --story <id>       Export this story; defaults to the most recently updated
  --all              Export every story, newest first, with numeric suffixes
                     for equal file names
  --format <format>  Write a NovelAI story, scenario, or lorebook archive
  --force            Replace the selected output file
  --data <path>      Open this project root instead of discovering one
  --global           Open the machine-wide project instead of a folder`;

export const IMPORT_HELP = `1667 import — make a new story from a file

Usage: 1667 import [--data <path>|--global] <file...>

Makes one new story from each Markdown, SillyTavern (.jsonl), NovelAI .story,
or NovelAI .scenario file.

In Markdown, '##' headings become chapter boundaries. Prose blocks become story
parts.

In a chat file, each character message becomes a story part; the user messages
before it become that part's direction, and unanswered ones at the end are
dropped.

A .story container also carries its embedded lorebook, its Memory, and its
Author's Note. Memory becomes one always-active Fact. The command reports what
it changed or omitted on standard error.

Import never writes back to the file it read. One unreadable file does not stop
the others: the command reports each failure and exits non-zero at the end.

To add Facts to a story that already exists, use 1667 import-card or
1667 import-lorebook.

Options:
  --data <path>      Open this project root instead of discovering one
  --global           Open the machine-wide project instead of a folder`;

export const IMPORT_CARD_HELP = `1667 import-card — add character card Facts to a story

Usage: 1667 import-card --story <id-or-title> [--data <path>|--global] <file...>

Adds Facts from one or more V1 or V2 JSON or PNG character cards to a story
that already exists. It does not make a new story, so --story is required.

The command palette command 'import character card' does the same for the open
story.

One unreadable file does not stop the others: the command reports each failure
and exits non-zero at the end.

Options:
  --story <id-or-title>  The story that receives the Facts; required
  --data <path>          Open this project root instead of discovering one
  --global               Open the machine-wide project instead of a folder`;

export const IMPORT_LOREBOOK_HELP = `1667 import-lorebook — add NovelAI lorebook Facts to a story

Usage: 1667 import-lorebook --story <id-or-title> [--data <path>|--global] <file...>

Adds one Fact for each entry of a NovelAI .lorebook archive, as JSON or inside
a PNG, to a story that already exists. It does not make a new story, so --story
is required.

An entry's text becomes the Fact text and its category or display name becomes
the tag. Entry keys become Fact keys with keyed activation; an always-on entry
arrives as an always-active Fact. A disabled entry is skipped.

The command reports what it imported, changed, or dropped on standard error.

The command palette command 'import archive' does the same for the open story,
and also reads .scenario and .story files.

Options:
  --story <id-or-title>  The story that receives the Facts; required
  --data <path>          Open this project root instead of discovering one
  --global               Open the machine-wide project instead of a folder`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
  export: EXPORT_HELP,
  import: IMPORT_HELP,
  "import-card": IMPORT_CARD_HELP,
  "import-lorebook": IMPORT_LOREBOOK_HELP
};

/** The help page for a command, or null when the command has none. */
export function commandHelp(command: string): string | null {
  return COMMAND_HELP[command] ?? null;
}

/** True when the arguments ask for help rather than for work.
 *
 * A command's own parser refuses an option it does not know, so the request has
 * to be answered before parsing. Otherwise `1667 import --help` reports an
 * unknown option, which is the least useful answer to that question. */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}
