# AGENTS.md

## Documentation

All technical documentation, including every README file, MUST comply with
ASD-STE100 Simplified Technical English.

- Use the ASD-STE100 writing rules and approved vocabulary.
- Use one term for one meaning.
- Use short, direct sentences and the active voice.
- Put only one instruction in each sentence.
- Declare necessary product terms as Technical Names or Technical Verbs, and use
  them consistently.
- Check new and changed documentation for ASD-STE100 compliance before you
  commit it.

Code, commands, file names, API names, and quoted interface text can keep their
exact spelling.

## Changelog credits

Credit a contributor only when the contributor is not `@10fra`.
Do not credit `@10fra` in `CHANGELOG.md`.

## Issue closure

Do not close an issue until its change is available in a stable release.
Keep issues open when you merge implementation work or publish a prerelease.

## Automated tests

Write an end-to-end test or an integration test for new behavior. Write a unit
test only when an end-to-end test and an integration test cannot show the
behavior.

These are the Technical Names for the three test types:

- An end-to-end test operates the product through an external interface.
- An integration test operates two or more components together.
- A unit test operates one component alone.

Obey these rules:

- Test the behavior that the user gets. Do not test the internal structure.
- Do not write a unit test that repeats an end-to-end test.
