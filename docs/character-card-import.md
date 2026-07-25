---
summary: Supported SillyTavern character-card import formats and field mapping
read_when:
  - changing story fact import or limits
  - changing supported character-card formats
  - changing how card fields enter prompts
---

# Character-card import

1667 can take a local SillyTavern-compatible character card and convert its character-defining prose into ordinary story facts. This is a one-time, editable snapshot. It does not install a card, retain a link to its source, synchronize later changes, execute card behavior, or create a reusable character library.

## Supported files

- Character Card V1 JSON.
- Character Card V2 JSON with `spec: "chara_card_v2"`, `spec_version: "2.0"`, and its core `data` object.
- PNG cards containing either payload as Base64 JSON in one uncompressed `tEXt` chunk named `chara`.
- A PNG with both a V3 `ccv3` chunk and a V1/V2 fallback `chara` chunk uses only the fallback.

One `.png` or `.json` file can be selected at a time from the open story's Facts panel. The importer does not fetch URLs. Missing or unsupported spec versions, Character Card V3-only PNG, CHARX, WebP, compressed PNG text metadata, and ordinary images without card metadata are rejected with no story change.

## Field boundary

The preview allowlists four core fields:

- `name` is required and editable.
- `description` and `personality` are selected by default when present.
- `scenario` is shown but starts unchecked because it often describes a particular chat rather than durable character truth.

Checked, non-empty sections become facts tagged `Character`. The importer replaces `{{char}}` with the edited name and `{{user}}` with `the protagonist` in one case-insensitive pass. Replacement text is not scanned again.

All other card data is ignored before preview and cannot enter facts: first or alternate greetings, example dialogue, system prompts, post-history instructions, creator notes and metadata, tags, extensions, character books/lorebooks, and image pixels. In particular, downloaded prompt or instruction fields are data outside 1667's trust boundary; importing them would let a card alter application behavior rather than merely describe a character.

## Packing and limits

The preferred result is one readable fact with named sections. Longer content is packed at section boundaries, then paragraph, line, or word boundaries, and finally at a Unicode-safe hard boundary. Every continuation repeats the character name and section label. Selected text is never truncated, and no fact exceeds 4,000 UTF-16 code units.

- Whole local file: 20 MB maximum, checked before the browser reads it.
- Decoded card JSON: 1 MB maximum, with Base64 size screened before decoding.
- Character name: 200 UTF-16 code units maximum.
- Story capacity: 128 total facts.
- Atomic save body: 1 MB of UTF-8 JSON, measured after JSON escaping and before submission.

The preview shows generated fact count, estimated tokens, and save-body size. Capacity or body-size overflow disables import. The server validates every generated fact before appending any of them and performs one locked story save, so a malformed or oversized batch adds nothing.

Imported facts follow the same prompt rules as hand-written facts. All remain fixed story-wide context for writing and titling operations on every line, and are never silently clipped. If the full canonical facts message cannot fit the selected model's configured context window, generation stops and asks the author to shorten or consolidate facts.
