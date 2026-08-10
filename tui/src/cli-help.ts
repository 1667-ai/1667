/** Command-line help, one page per command.
 *
 * The front page must fit a small terminal. A writer who cannot see the usage
 * lines cannot find the command they wanted, so detail lives on the page of the
 * command it belongs to and the front page stays a map. */

export const HELP = `1667 — a full-screen terminal environment for writing fiction
Usage: 1667 [options]
       1667 <command> [options]

Commands:
  init             Make a project in this directory
  encrypt          Seal this project with a Vault Password
  decrypt          Unseal this project
  export           Write a story to Markdown or a NovelAI archive
  import           Make a new story from a file
  import-card      Add Facts from a character card to a story that exists
  import-lorebook  Add Facts from a NovelAI lorebook to a story that exists
  profile          Import or export a Generation Profile
  serve            Run the HTTP server
  auth             Show an access record
  upgrade          Update this program
Options:
  --story <id>       Open this story instead of the most recently updated
  --data <path>      Open this project root instead of discovering one
  --global           Open the machine-wide project instead of a folder
  --url [base-url]   Connect to a loopback 1667 HTTP server; bare reads run.json
  --auth-file <path> Use the canonical private auth record for --url
  --version [--json] Print embedded build identity
Run '1667 <command> --help' for one command, or read docs/development.md.`;

export const EXPORT_HELP = `1667 export — write a story to a file

Usage: 1667 export [--story <id>|--all] [--format story|scenario|lorebook]
                   [--force] [--passphrase-file <path>] [--data <path>|--global]

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
  --passphrase-file <path>  Read the Vault Password from this file
  --data <path>      Open this project root instead of discovering one
  --global           Open the machine-wide project instead of a folder`;

export const IMPORT_HELP = `1667 import — make a new story from a file

Usage: 1667 import [--passphrase-file <path>] [--data <path>|--global] <file...>

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
  --passphrase-file <path>  Read the Vault Password from this file
  --data <path>      Open this project root instead of discovering one
  --global           Open the machine-wide project instead of a folder`;

export const IMPORT_CARD_HELP = `1667 import-card — add character card Facts to a story

Usage: 1667 import-card --story <id-or-title> [--passphrase-file <path>]
                       [--data <path>|--global] <file...>

Adds Facts from one or more V1, V2, or V3 JSON or PNG character cards to a
story that already exists. It does not make a new story, so --story is
required. A PNG with a V3 'ccv3' chunk reads that chunk over a V1 or V2
'chara' fallback.

A V2 or V3 card's embedded character_book becomes Facts too, one for each
entry, through the same mapping as 1667 import-lorebook. The command reports
what it imported or omitted on standard error.

The command palette command 'import character card' does the same for the open
story.

One unreadable file does not stop the others: the command reports each failure
and exits non-zero at the end.

Options:
  --story <id-or-title>  The story that receives the Facts; required
  --passphrase-file <path>  Read the Vault Password from this file
  --data <path>          Open this project root instead of discovering one
  --global               Open the machine-wide project instead of a folder`;

export const IMPORT_LOREBOOK_HELP = `1667 import-lorebook — add lorebook Facts to a story

Usage: 1667 import-lorebook --story <id-or-title> [--passphrase-file <path>]
                           [--data <path>|--global] <file...>

Adds one Fact for each entry of a lorebook to a story that already exists. It
does not make a new story, so --story is required.

It reads a NovelAI .lorebook archive, as JSON or inside a PNG, and a SillyTavern
World Info .json file. 1667 reads the file to know which format it has. It does
not use the file name.

An entry's text becomes the Fact text and its category or display name becomes
the tag. Entry keys become Fact keys with keyed activation; an always-on entry
arrives as an always-active Fact. A disabled entry is skipped.

The command reports what it imported, changed, or dropped on standard error.

The command palette command 'import archive' does the same for the open story,
and also reads .scenario and .story files.

Options:
  --story <id-or-title>  The story that receives the Facts; required
  --passphrase-file <path>  Read the Vault Password from this file
  --data <path>          Open this project root instead of discovering one
  --global               Open the machine-wide project instead of a folder`;

export const PROFILE_HELP = `1667 profile — import or export a Generation Profile

Usage: 1667 profile import [--profile <name>] [--passphrase-file <path>]
                            [--data <path>|--global] <file...>
       1667 profile export [--profile <name>] [--force] [--passphrase-file <path>]
                            [--data <path>|--global]

Import reads a NovelAI Sampler Preset or a Profile Export. It creates a new
Generation Profile and does not change the selected profile. 1667 reports
parameters that the selected route cannot use on standard error.

Export writes a shareable Profile Export JSON file in the project root. It
does not include a connection, credentials, headers, or private endpoint data.

Options:
  --profile <name>  Select a profile ID or unique profile name
  --force           Replace the export file
  --passphrase-file <path>  Read the Vault Password from this file
  --data <path>     Open this project root instead of discovering one
  --global          Open the machine-wide project instead of a folder`;

export const INIT_HELP = `1667 init — make a project in this directory

Usage: 1667 init [--adopt [--from <legacy-data-dir>]]

Makes .1667/ in the current directory. Stories live there, beside your writing,
and 1667 finds them by walking up from the current directory the way git finds
.git.

Use separate project roots for separate story libraries.

Options:
  --adopt            Adopt an existing legacy data directory
  --from <path>      The legacy data directory to adopt; requires --adopt`;

export const ENCRYPT_HELP = `1667 encrypt — seal this project

Usage: 1667 encrypt [--passphrase-file <path>] [--data <path>|--global]

Seals every project file except control files. The command changes the project
to format 5. A stopped seal resumes when you run this command again.

With a terminal, enter the Vault Password two times. Without a terminal, use
--passphrase-file. The file must be outside the data directory. An empty Vault
Password is refused.

If you lose the Vault Password, 1667 cannot recover the vault.

Options:
  --passphrase-file <path>  Read the Vault Password from this file
  --data <path>             Open this project root instead of discovering one
  --global                  Open the machine-wide project instead of a folder`;

export const DECRYPT_HELP = `1667 decrypt — unseal this project

Usage: 1667 decrypt [--passphrase-file <path>] [--data <path>|--global]

Unseals every project file and changes the project to format 4. A stopped
unseal resumes when you run this command again.

With a terminal, enter the Vault Password. Without a terminal, use
--passphrase-file. The file must be outside the data directory. An empty Vault
Password is refused.

Options:
  --passphrase-file <path>  Read the Vault Password from this file
  --data <path>             Open this project root instead of discovering one
  --global                  Open the machine-wide project instead of a folder`;

export const AUTH_HELP = `1667 auth — show an access record

Usage: 1667 auth show --scope <story|admin> (--url <base-url> | --auth-file <path>)

Prints the access record a client needs to reach a running 1667 HTTP server.
The story scope reads and writes stories. The admin scope also controls the
server.

Give exactly one of --url and --auth-file. The command refuses to print a
capability to output that is not a terminal.

Options:
  --scope <scope>    story or admin; required
  --url <base-url>   Read the record for the server at this base URL
  --auth-file <path> Read the canonical private auth record from this path`;

const COMMAND_HELP: ReadonlyMap<string, string> = new Map([
  ["init", INIT_HELP],
  ["encrypt", ENCRYPT_HELP],
  ["decrypt", DECRYPT_HELP],
  ["auth", AUTH_HELP],
  ["export", EXPORT_HELP],
  ["import", IMPORT_HELP],
  ["import-card", IMPORT_CARD_HELP],
  ["import-lorebook", IMPORT_LOREBOOK_HELP],
  ["profile", PROFILE_HELP]
]);

/** The help page for a command, or null when the command has none. */
export function commandHelp(command: string): string | null {
  return COMMAND_HELP.get(command) ?? null;
}

/** True when the first argument after a command asks for help.
 *
 * A command's own parser refuses an option it does not know, so the request has
 * to be answered before parsing. Otherwise `1667 import --help` reports an
 * unknown option, which is the least useful answer to that question.
 *
 * Only the first position counts. Later on, the flag may belong to the option
 * before it: `--data` and `--from` take the next argument whatever it looks
 * like, so `1667 import --data -h` names a directory and is not a question. */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv[0] === "--help" || argv[0] === "-h";
}
