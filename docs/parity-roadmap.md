---
summary: Feature gaps against SillyTavern and NovelAI, sorted by value against effort
read_when:
  - planning parity work against SillyTavern or NovelAI
  - deciding the next context, sampling, import, or provider feature
  - writing material that invites NovelAI users
---

# Feature parity roadmap

This document compares 1667 with SillyTavern 1.18.0 and with NovelAI in the
Xialong era. The research date is 2026-08-02. The target user is the technical
and privacy-minded NovelAI subscriber.

## Technical terms

This document declares these additional terms:

| Term | Meaning |
| --- | --- |
| World Info | The SillyTavern keyword-triggered lore system |
| phrase bias | A text phrase and a weight that change token probability |
| banned string | A text phrase that the model must not produce |
| text completion | A provider request that sends one prose prefix and no chat messages |
| instruct template | A configuration that wraps prose in model-specific control tokens |
| sampler preset | A named collection of sampling parameter values |

## Position

SillyTavern is a chat client. It has the deepest mechanism set in this
category. It refused a continuous story editor. The SillyTavern project closed
the story-editor feature request (issue 2516) without action.

NovelAI has the story editor. It locks the user to Anlatan models, Anlatan
context limits, and Anlatan prices. It does not accept an external model or an
external endpoint.

1667 already has the form that SillyTavern refused: a prose-first editor with
takes, a story line, and chapters. The parity strategy is therefore narrow:

- Do not copy chat features. Group chats, personas, greetings, avatars, and
  expression sprites serve chat roleplay. They do not serve prose.
- Copy context control, steering control, and sampling control. These features
  serve prose directly.
- Build import paths and migration paths. A switcher arrives with years of
  stories, Lorebooks, and presets.
- Keep the privacy lead. 1667 stores plain local data, sends no telemetry, and
  ships with the update check off. NovelAI stores encrypted server data. A
  password reset there destroys the stored stories.

## What 1667 already matches

| Area | 1667 today |
| --- | --- |
| Story editor | Take tree, story line, three maps, chapters, full-screen editor |
| Memory | NovelAI Memory imports as an `always` Fact; an `always` Fact gives the same persistent context block |
| Author's Note | One per story, near the end of the request |
| Lorebook | Keyed Facts with word and phrase keys; NovelAI Lorebook import |
| Context transparency | Request viewer and context meter; NovelAI has the context viewer; SillyTavern has prompt itemization |
| Sampling | temperature, top_p, top_k, min_p, penalties, stop sequences, logit bias |
| Providers | OpenAI, Anthropic, OpenRouter, LM Studio, Ollama, llama.cpp, KoboldCpp (OpenAI-compatible) |
| Import | SillyTavern chats, character cards V1 and V2, NovelAI `.story`, `.scenario`, `.lorebook`, Markdown |
| Privacy | Local plain data, no telemetry, credential isolation, HTTPS rules |

Note: NovelAI removed most sampling parameters in the GLM era. Current NovelAI
exposes temperature, top_k, top_p, and min_p. 1667 already matches that set.
The long sampler tail matters mainly to local-model users.

## Ranked gaps

Value measures pull on the target user. Effort measures work in this codebase.
Each tier is sorted, best ratio first.

### Tier 1: high value, low or medium effort

| # | Gap | Value | Effort | Issue |
| --- | --- | --- | --- | --- |
| 1 | Selection rewrite in the TUI | High | Low to medium | [#277](https://github.com/1667-ai/1667/issues/277) |
| 2 | Per-story author brief | High | Low | [#278](https://github.com/1667-ai/1667/issues/278) |
| 3 | SillyTavern World Info import | High | Low | [#279](https://github.com/1667-ai/1667/issues/279) |
| 4 | "Move from NovelAI" guide | High | Low | [#280](https://github.com/1667-ai/1667/issues/280) |
| 5 | Fact order, priority, and budget | High | Medium | [#281](https://github.com/1667-ai/1667/issues/281) |
| 6 | Phrase bias and banned strings | High | Medium | [#282](https://github.com/1667-ai/1667/issues/282) |
| 7 | Author's Note placement control | Medium | Low | [#283](https://github.com/1667-ai/1667/issues/283) |
| 8 | Seed parameter | Medium | Low | [#284](https://github.com/1667-ai/1667/issues/284) |
| 9 | Character card V3 and CHARX | Medium | Medium | [#285](https://github.com/1667-ai/1667/issues/285) |

1. **Selection rewrite in the TUI.** The backend has the two-anchor rewrite
   operation. The TUI does not expose it. NovelAI users edit anywhere in the
   document and regenerate. Ship the existing operation as a key and a palette
   command. The seam contract fails on small models; issue 277 records the
   diagnosis and a staged rework toward bare replacement with statistical
   seam checks.
2. **Per-story author brief.** The author brief is machine-wide today. A novel
   and a short story need different instructions. Add a story-level override.
3. **SillyTavern World Info import.** 1667 imports the NovelAI Lorebook shape
   only. Add the SillyTavern World Info JSON shape to the same Entry Mapping
   and Fidelity Report pipeline. Switchers carry large World Info files.
4. **"Move from NovelAI" guide.** Write one document that maps Memory,
   Author's Note, Lorebook, and `.story` files to 1667 features. State the
   privacy comparison plainly. This document converts the target user.
5. **Fact order, priority, and budget.** Facts emit in insertion order, all or
   nothing. NovelAI gives per-entry priority, budget, and position. Add an
   order control, a priority rank for window pressure, and a per-Fact token
   budget.
6. **Phrase bias and banned strings.** 1667 logit bias accepts numeric token
   identifiers only, with a cap of 16. NovelAI users bias and ban phrases as
   text, in large sets. Accept text phrases, tokenize per model, and raise the
   caps where the protocol allows. Tokenization is model-dependent, so support
   differs per backend; issue 282 records the per-backend design, the
   server-side tokenize probe, and the multi-token limits.
7. **Author's Note placement control.** The placement is fixed before the last
   story part. NovelAI and SillyTavern both offer depth control. Add a small
   depth setting.
8. **Seed parameter.** Reproducible generations serve technical users. The
   OpenAI-compatible protocol accepts `seed`. The Sampling group already has
   the capability matrix for it.
9. **Character card V3 and CHARX.** The converter rejects V3-only cards. The
   card ecosystem writes V3 chunks now. Read V3 JSON, the `ccv3` PNG chunk,
   and the CHARX container. Map `character_book` entries to keyed Facts.

### Tier 2: high value, higher effort

| # | Gap | Value | Effort | Issue |
| --- | --- | --- | --- | --- |
| 10 | NovelAI provider protocol | High | High | [#286](https://github.com/1667-ai/1667/issues/286) |
| 11 | Automatic chapter summaries | High | Medium | [#287](https://github.com/1667-ai/1667/issues/287) |
| 12 | Exact token counts | Medium | Medium | [#288](https://github.com/1667-ai/1667/issues/288) |
| 13 | Keyed Fact logic: regex, AND, NOT, recursion | Medium | Medium | [#289](https://github.com/1667-ai/1667/issues/289) |
| 14 | Sampler presets and `.preset` import | Medium | Medium | [#290](https://github.com/1667-ai/1667/issues/290) |
| 15 | Token probability viewer | Medium | Medium | [#291](https://github.com/1667-ai/1667/issues/291) |
| 16 | Long-tail samplers for local servers | Medium | Medium | [#292](https://github.com/1667-ai/1667/issues/292) |
| 17 | Text completion protocol | Medium | High | [#293](https://github.com/1667-ai/1667/issues/293) |

10. **NovelAI provider protocol.** SillyTavern cannot drive the NovelAI GLM
    models (SillyTavern issue 4575, open since 2025). A NovelAI connection
    makes 1667 the only serious external editor for a current NovelAI
    subscription. The subscriber keeps unlimited generations and gains the
    1667 editor. Confirm the terms of service before the work.
11. **Automatic chapter summaries.** Chapter summaries and summary takes are
    manual. Long-form memory is the top NovelAI pain after price. Offer an
    automatic summary when a chapter closes or when the context meter shows
    window pressure.
12. **Exact token counts.** The context meter estimates four characters per
    token. Technical users compare the meter with provider bills. Use the
    exact tokenizer where one exists, and label estimates as estimates.
13. **Keyed Fact logic.** Keyed Facts match plain keys in one pass. NovelAI
    supports regex keys and conditional entries. SillyTavern adds AND, NOT,
    and recursion. Add regex keys first. Add secondary-key logic second.
    Add recursion last.
14. **Sampler presets and `.preset` import.** Generation Profiles exist. Add
    import for the NovelAI `.preset` file and a small set of named presets per
    protocol.
15. **Token probability viewer.** NovelAI users praise their token probability
    tool. The OpenAI-compatible protocol returns logprobs. A terminal renders
    this well. This is a visible differentiator.
16. **Long-tail samplers for local servers.** llama.cpp and KoboldCpp accept
    DRY, XTC, dynamic temperature, and Mirostat fields on their
    OpenAI-compatible endpoints. The capability matrix already gates values
    per preset. Add the fields where the server accepts them.
17. **Text completion protocol.** All requests are chat requests today. Base
    models and prose finetunes write better through text completion. This
    needs a new protocol, boundary rules, and minimal instruct templates.
    The chat protocols of llama.cpp and KoboldCpp reduce the urgency.

### Tier 3: later, or out of scope

| # | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- |
| 18 | Scenario placeholder forms | Low | Medium | Later |
| 19 | Ephemeral and timed context entries | Low | Medium | Later |
| 20 | Text adventure input mode | Low | Medium | Later |
| 21 | Configurable keybindings | Low | Medium | Later |
| 22 | Regex output pipelines | Low | Medium | Later |
| 23 | Vector storage and document RAG | Medium | Very high | Later |
| 24 | Scripting and macros | Low | Very high | No |
| 25 | Translation, TTS, image generation | Low | High | No |
| 26 | Group chats, personas, expressions | Low | High | No |

Summary takes and chapter summaries already cover part of the RAG use case.
Items 24 to 26 serve chat roleplay or need a plugin surface. They do not serve
the position above.

Tier 1 and Tier 2 have tracking issues. Tier 3 has no tracking issues. Open an
issue for a Tier 3 item when work on it starts.

## Tracked work that overlaps

- Issue 265: `.story` export does not write the Facts, Memory, and Author's
  Note that `.story` import reads. This blocks a round trip and belongs with
  Tier 1.

## Sources

- SillyTavern documentation: https://docs.sillytavern.app/
- SillyTavern releases 1.13.0 to 1.18.0:
  https://github.com/SillyTavern/SillyTavern/releases
- Story editor refusal: https://github.com/SillyTavern/SillyTavern/issues/2516
- NovelAI GLM gap: https://github.com/SillyTavern/SillyTavern/issues/4575
- Character Card V3 specification:
  https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md
- NovelAI community knowledge base:
  https://github.com/TapwaveZodiac/novelaiUKB
- NovelAI model announcements: https://blog.novelai.net/
