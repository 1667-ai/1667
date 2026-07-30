---
summary: Automatic story names and the story context that naming uses
read_when:
  - changing automatic story names
  - changing the context for a naming request
---

# Automatic story names

Open the command palette with `Ctrl+P` or `:`. Run **Autoname story** to ask
the selected model for a short story name.

The story must contain prose. The naming request uses these items:

- The active story line
- Facts
- The author brief

1667 limits story prose in the request to 24,000 characters. It keeps text from
the start and the newest direction of the story. For a fork, it separates
inherited prose from new branch prose. It also includes the source story name.

1667 changes only the story name. It rejects the result if the story name
changes while the request is active.

Run **Rename story** to enter a name without a model request. In Library, you
can also press `e` to rename the selected story.
