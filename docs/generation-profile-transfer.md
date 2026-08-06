---
summary: Import, export, and start a Generation Profile
read_when:
  - importing a NovelAI Sampler Preset
  - moving a Generation Profile between projects
  - selecting a Starter Profile
---

# Generation Profile transfer

A **Sampler Preset** is a NovelAI `.preset` file. A **Profile Export** is a
shareable JSON file that holds one Generation Profile. A **Starter Profile** is
one named Generation Profile that 1667 ships.

Run `1667 profile import <file>` to read a Sampler Preset or a Profile Export.
The command creates a new Generation Profile. It does not change the source
profile. Use `--profile <name>` to select the target route. Without that option,
1667 uses the prose route or the default route.

In the TUI, select the **profile** row and press `i`. Select a Starter Profile
or select `read a file…`. The TUI changes the Settings draft. Press `s` to save
the draft. Select **export generation profile** in the command palette to write
a Profile Export.

Run `1667 profile export` to write a Profile Export in the project root. The
export contains generation behavior and sampling settings. It does not contain
a connection, a model identifier, credentials, headers, private endpoint data,
or timeouts.

1667 imports temperature, maximum output, top P, top K, min P, frequency
penalty, presence penalty, and Mirostat. 1667 imports Mirostat as version 2
because NovelAI does not store a version. The Fidelity Report states this
assumption.

A known model output limit can reduce imported maximum output. The Fidelity
Report states the limit.

1667 does not import NovelAI repetition penalty, token IDs, stop sequences,
logit bias, classifier-free guidance, or sampler values with no equivalent.
NovelAI token IDs belong to a different vocabulary. 1667 reports each omitted
or unavailable value in the Fidelity Report.

Starter Profiles are `conservative`, `balanced`, and `adventurous prose`.
They apply through the same route checks as imports. A route can omit a Starter
Profile value when its provider cannot use that value.
