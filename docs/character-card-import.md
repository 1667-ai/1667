---
summary: Character-card conversion formats, field mapping, and limits
read_when:
  - changing character-card conversion or limits
  - adding a character-card import interface
---

# Character-card conversion

The shared character-card module converts selected character fields to Fact
inputs. The current product has no character-card import action. The module
does not save the result.

## Supported files

The module supports these inputs:

- Character Card V1 JSON
- Character Card V2 JSON with `spec: "chara_card_v2"` and
  `spec_version: "2.0"`
- PNG cards with V1 or V2 JSON in one uncompressed `tEXt` chunk named `chara`

If a PNG has a V3 `ccv3` chunk and a V1 or V2 fallback `chara` chunk, the
module uses the fallback.

The module does not fetch URLs. It rejects V3-only cards, CHARX files, WebP
files, compressed PNG text metadata, and ordinary images.

## Field mapping

The `name` field is necessary. A caller can select `description`,
`personality`, and `scenario`.

The module changes `{{char}}` to the character name. It changes `{{user}}` to
`the protagonist`. It changes all matches in one case-insensitive pass. It does
not scan replacement text again.

Each non-empty selected section becomes part of a Fact input with the
`Character` tag. The module ignores all other card fields.

## Packing and limits

The module first packs text at section boundaries. It then uses paragraph,
line, word, and Unicode-safe boundaries. It does not truncate selected text.

- Maximum input file size: 20 MB
- Maximum decoded JSON size: 1 MB
- Maximum character name length: 200 UTF-16 code units
- Maximum Fact input length: 4,000 UTF-16 code units
- Maximum result: 128 Fact inputs
