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
| story part | One unit of story prose |
| take | One alternative version of a story part |
| story line | The selected path through story parts |
| tag | A name and a status on the end of one story line |
| Fact | One note that 1667 sends with a provider request |
| Author's Note | One short instruction that 1667 sends near the end of each provider request |
| Fact tag | A category name for a Fact |
| context meter | The side-rail view of the next provider request size |
| request viewer | The read-only view of the next provider request plan |
| Sampling group | The Settings group for sampling parameters |
| sampling parameter | One provider request field that changes how the model selects tokens |
| stop sequence | One text sequence that stops generation |
| logit bias | A token identifier and a weight that changes token probability |
| mass map | A map that shows all takes |
| provider | A local or hosted service that supplies a language model |
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
