import assert from "node:assert/strict";
import test from "node:test";
import {
  authorsNoteWarning,
  AUTHORS_NOTE_WARN_TOKENS
} from "../shared/authors-note.js";

test("Author's Note warning uses the exact threshold and sheds by available width", () => {
  assert.equal(authorsNoteWarning("x".repeat(AUTHORS_NOTE_WARN_TOKENS * 4)), null);

  const note = "x".repeat(AUTHORS_NOTE_WARN_TOKENS * 4 + 1);
  const full = "· 301 tokens — a long note crowds the prose it steers";
  const short = "· 301 tokens — long notes crowd the prose";
  const count = "· 301 tokens";
  assert.equal(authorsNoteWarning(note, full.length), full);
  assert.equal(authorsNoteWarning(note, short.length), short);
  assert.equal(authorsNoteWarning(note, count.length), count);
});
