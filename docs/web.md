---
summary: Start and use the web UI that `1667 web` serves
read_when:
  - changing `1667 web` or the web UI
  - changing the keys of the web UI
  - answering a question about the token URL or the project lock
---

# Web UI

The web UI is a browser page for your story project. It does the same work as
the TUI. You can write, read, and change stories in it.

This document uses these Technical Names:

- The web UI is the browser page that `1667 web` serves.
- The token URL is the address that `1667 web` prints. It has a private token.
- The project lock is the lock that lets one process at a time open a project.

## Start the web UI

Go to a project folder. Run this command:

```sh
1667 web
```

The command opens the project. It takes the project lock. It prints the token
URL:

```text
1667 web: serving /path/to/project at http://127.0.0.1:53124/#token=...
Press Ctrl+C to stop.
```

By default, the command opens the token URL in your browser. If it cannot open
the browser, open the token URL yourself.

Use these options to change the start:

| Option | Effect |
| --- | --- |
| `--data <path>` | Open this project root. |
| `--global` | Open the machine-wide project. |
| `--port <n>` | Use this port. The default is a free port. |
| `--no-open` | Do not open the browser. |

Press Ctrl+C to stop the command. The command closes the page and releases the
project lock.

## Keep the web UI private

The web UI listens on the loopback address `127.0.0.1` only. Other computers
cannot reach it.

The token URL holds a private token in its fragment. The browser does not send
the fragment to the server. The page reads the token. Then it removes the token from the
address bar. The page keeps the token for this tab only. Each run makes a new
token.

Obey these rules:

- Do not share the token URL. Anyone who has it can read and change your
  stories.
- Open the token URL again after you restart the command.

The server refuses a request that has no token. It also refuses a request that
has a wrong Host header or a foreign Origin header.

## The project lock

`1667 web` takes the project lock for as long as it runs. The TUI, `1667 serve`,
and a second `1667 web` cannot open the same project at this time. They stop
with an error that names the process that holds the lock.

To use the TUI again, press Ctrl+C in the terminal that runs `1667 web`.

The web UI and the TUI keep one reading position for each story. The program
that runs second opens the story at the position that the first one saved.

## What the web UI does

### Library

The Library lists your stories. Use it to create, open, rename, and delete a
story. Type in the filter to find a story by its title. Press `o` to switch
story or to go to the Library.

Choose light or dark. Choose one color palette: Ink, Typewriter, Grove, or Nocturne. The
web UI remembers your choice in this browser.

### Story page and writing

A story page shows the story line that you selected, one story part at a time.
Press the arrow keys to move between story parts and between takes.

Use the composer to make the next story part:

- Continue asks the model for the next story part. Press Space.
- Direct asks the model for a story part that follows your direction. Press
  Enter or `i`, type the direction, and send it.
- Retake asks the model for a new take of the selected story part. Press `r`.
  Press `R` to edit the prompt first.
- Write lets you type a take yourself. Press `w`. You do not need a model.
- Edit changes the prose and the prompt of a take. Press `e`.

Press Esc to stop a request that runs. Press `x` to open the actions menu for
a story part. Press `D` to delete a take and the takes below it. Press `y` to
copy a story part. Press `Y` to copy the whole story line.

Press `n` to edit the Author's Note. In the command palette, choose "author
brief" to edit the Author Brief. Choose "autoname story" to ask for a title.

### Map

Press `m` to open the map. The map shows all takes of the story. It has the
path view, the tree view, and the mass view. Press `m` again to change the
view. Press `a` to show or hide the sketches. Press Enter on a take to select
the story line that goes through it.

### Tags and chapters

Press `t` to tag the story line at the selected story part. A tag has a name
and a status. Press `c` to open the chapters. Press `C` to end a chapter at the
selected story part. Press `[` and `]` to go to the previous and next chapter.
Press `u` to undo the last chapter break change.

### Facts and Fact States

A Fact is a note that 1667 sends with each request. Press `f` to open the
Facts. Use the Facts view to add, change, and delete a Fact. Each Fact shows
the Fact budget that it uses.

A Fact State is one version of the Fact body. Add a Fact State at a story part
to change the Fact from that story part on. An End State stops the Fact on that
story line. A Fact State shows an Anchor mark at its story part.

Press `F` to show the Facts rail, or to set it to auto or off.

### Fact consistency check

A Fact consistency check reads a chapter or a story line. It reports prose that
contradicts a Fact. In the command palette, choose "check chapter against
Facts" or "check story line against Facts". The page shows how many story parts
and requests the check uses. Choose Check to start it.

The Findings view lists each finding: the Fact, the quote, and the
contradiction. Click a finding to go to its story part. Choose "show Fact
findings" to open the last check again.

### Aside

Aside is a chat about the story. It does not change the story. Press `a` to
open it. Ask a question and read the answer. Use the Use menu of an answer to put
its text in the story.

### Search

Press `/` to search the text of the story. Type two or more characters. Press
Tab to search all stories. Press Enter to go to a hit. Select "Aa" to match
case.

### Command palette, keys help, and notice log

- Press `:` to open the command palette. Type to find a command. Press Enter to
  run it.
- Press `?` to open the keys help. It lists the keys that the web UI uses.
- Press `!` to open the notice log. It lists the messages of this tab.
- Press Esc to close each of them.

### Settings

Press `,` or click the gear in the sidebar to open the settings. The Simple view
shows the main rows. The Advanced view shows every row. The settings include
the provider, the base URL, the model, the context size, the Default Author
Brief, and the Default Continue direction. They also include the sampling
parameters and the Generation Profiles. Choose Save to keep your changes.

### Context meter and inspectors

The composer shows the context meter. It shows the size of the next request and
the context window. Click it to see the parts of the request: voice, Facts,
recent text, summary, and note. It also shows which Facts the request sends and
which chapters it holds.

Each inspector is a page. Press Esc or the Back button to close it.

- The request viewer shows the exact messages of the next request. Choose "next
  request" in the command palette. On a Mac, press Control+R.
- The Generation Record Viewer shows how a take was made. Press `h`.
- The token probability viewer shows the alternative tokens of a take. Press
  `l`.
- Press Shift+T to show or hide the stored thought of a take.

### Import and export

To import a file, open the Library. Click Import, or drop a file on the page.
The web UI reads these files:

| File | Result |
| --- | --- |
| `.md` | A new story |
| `.jsonl` | A new story from a SillyTavern chat |
| `.story`, `.scenario` | A new story from a NovelAI Archive |

In an open story, open the command palette. Choose "import character card" to
add the Facts of a character card. Choose "import archive" to add the Facts of
a `.lorebook`, `.json`, or `.png` file. A dialog lists the Facts that the import
added and the data that it left out. The web UI refuses a file above 20 MB.

To export, open the command palette and choose "export markdown". The browser
downloads the selected story line as a Markdown file. The file has prose only.

## Keys that differ from the TUI

The web UI uses the key table of the TUI. Press `?` to see the keys that the
web UI handles. The web UI differs from the TUI in these ways:

- The palette opens with `:` only. The browser keeps Ctrl+P for printing.
- Ctrl+R and Ctrl+G stay with the browser, except on a Mac. On a Mac, the
  browser uses Command, so Control is free for the web UI. Ctrl+R opens the
  request viewer. Ctrl+G opens the context details. On other systems, use the
  command palette or the context meter.
- Ctrl+U and Ctrl+D stay with the browser. Press Page Up and Page Down to
  scroll.
- Alt+Left and Alt+Right stay with the browser. They go back and forward in
  the history of the browser.
- A key does not run a command while a field has focus. Type in the field
  instead. Press Esc to leave the field.
- Ctrl+S matches case while the search field has focus. Everywhere else, the
  browser saves the page. The "Aa" button also matches case.
- `/` opens the full-text search.
- The web UI has no quit key. Press Ctrl+C in the terminal to stop it.
- The Back and Forward buttons of the browser move between the Library, a
  story, and its map.

## Settings and API keys

Open the settings and choose the provider. Type the API key in the API key
field. Choose Save.

1667 stores the API key on this computer. The web UI never shows the key again
after you save it. It shows only that a key is stored. To replace the key, type
a new key.

The web UI cannot sign in to a subscription plan. Run `1667 auth login` in a
terminal. See [Facts, context, and model providers](model-providers.md).
