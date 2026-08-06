---
summary: The Technical Names that 1667 documentation uses
read_when:
  - writing or changing a 1667 document
  - reading an unfamiliar product term in the README or the changelog
  - adding a product term to the documentation
---

# Technical terms

1667 documentation uses these Technical Names. Use one term for one meaning.

| Term | Meaning |
| --- | --- |
| TUI | The terminal user interface |
| backend | The service that stores stories and sends provider requests |
| character card | A V1 or V2 character card file that another tool wrote |
| project | A project root and its `.1667/` directory |
| reserved file | A control file that 1667 writes one time and does not change |
| scratch file | The temporary publication copy of one reserved file |
| story part | One unit of story prose |
| take | One alternative version of a story part |
| rewritten span | The range of prose in a story part that a rewrite replaced |
| story line | The selected path through story parts |
| tag | A name and a status on the end of one story line |
| Fact | One note that 1667 sends with a provider request |
| Fact priority | The rank 1667 uses to choose which Fact to drop first |
| Fact budget | The token limit on one Fact |
| Facts budget | The token limit on the total of a story's Facts |
| Author's Note | One short instruction that 1667 sends near the end of each provider request |
| Author's Note depth | The number of story parts from the end where the Author's Note occurs |
| Author Brief | The story or machine-wide instruction that 1667 sends with each provider request |
| Archive | A NovelAI `.story`, `.scenario`, or `.lorebook` file |
| Container | A `.story` Archive that contains prose and settings |
| Lorebook | A collection of NovelAI Lorebook Entries |
| Lorebook Entry | One record in a Lorebook |
| Entry Mapping | The map from one Lorebook Entry to one Fact |
| Memory | The persistent NovelAI context block |
| Fidelity Report | A list of import or export changes and omissions |
| Fact tag | A category name for a Fact |
| context meter | The side-rail view of the next provider request size |
| request viewer | The read-only view of the next provider request plan |
| token probability | The probability that the model gave one generated token |
| alternative token | One token that the model weighed at one position |
| token probability viewer | The read-only view of the alternative tokens of one take |
| tokenize source | The bundled tokenizer or the server endpoint that counts the tokens in one provider request |
| grade | The quality of a token count: exact count, near-exact count, or token estimate |
| mark | The symbol that shows a token count's grade |
| exact count | A token count from a bundled tokenizer, or a server count of a complete message array |
| near-exact count | A token count of server-tokenized content that 1667 cannot prove against the serving path |
| token estimate | A token count of four characters for each token |
| Generation Profile | One named set of model behavior settings |
| Generation Route | The selection of a Generation Profile for one type of work |
| Sampling group | The Settings group for sampling parameters |
| sampling parameter | One provider request field that changes how the model selects tokens |
| stop sequence | One text sequence that stops generation |
| logit bias | A token identifier and a weight that changes token probability |
| phrase bias | A text phrase and a weight that changes the probability of its tokens |
| banned string | A text phrase that gets a strong negative token bias, or, on KoboldCpp, a literal-text ban |
| DRY | A sampling parameter group that lowers the probability of a token sequence that would repeat |
| XTC | A sampling parameter group that removes the model's top token choices at random |
| Mirostat | A sampling algorithm that holds output perplexity near a target value |
| mass map | A map that shows all takes |
| provider | A local or hosted service that supplies a language model |
| Text Completions | The provider protocol that sends one text prompt and receives one text continuation |
| prompt format | The rule that converts a provider-neutral request into one text prompt |
| machine tier | Private 1667 data for one machine |
| project tier | Story data and settings in a `.1667/` directory |
| working tier | User files in a project root |
| frame | One complete terminal screen |
| standalone executable | One executable that contains the runtime dependencies |
| release target | One supported operating system and processor architecture |
| data-directory ID | A random identifier in project state that Git can track |
| data-directory claim ID | A machine-local identifier for one live copy of a project data directory |
| Installer | A Shell Installer or a PowerShell Installer |
| Shell Installer | A channel-specific release script that installs one native executable |
| PowerShell Installer | A Windows release script that installs one native executable |
| Managed Installation | An installation that an Installer creates and registers |
| Ownership Record | The durable file that gives 1667 authority to replace one executable |
| Install Root | The directory that holds the managed executable and the Ownership Record |
| Release Archive | The target-specific native archive in an immutable GitHub release |
| Platform Package | The target-specific npm package that holds one native executable |
| Candidate | An executable that an install or upgrade operation has not made active |
| Transaction Record | The durable file that records an incomplete install, upgrade, or rollback |

Add a term to this table before you use it in another document.

A document that needs more terms than these can declare them in its own
`Technical terms` section. [Release preflight](RELEASING.md) is an example.
