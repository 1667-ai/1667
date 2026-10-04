import { useEffect, useState } from "react";
import { formatBannedStringsText, formatPhraseBiasText, parseBannedStringsText, parsePhraseBiasText } from "../../../shared/story-sampling-text.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { withStoryListDraft } from "./story-lists.js";
import { failureToast, runStoryMutation } from "../app/story-mutation.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import { storyChangeRefusal } from "../story/story-policy.js";
import { BiasPreview } from "./SamplingSection.js";
import { Row, Section } from "./SettingsFields.js";
import type { LoadedSettings } from "./state.js";

type Field = "phrase-bias" | "banned-strings";

const FIELDS: readonly { readonly field: Field; readonly label: string; readonly help: string }[] = [
  {
    field: "phrase-bias",
    label: "Phrase bias",
    help: "One per line, as phrase: weight. The weight is a whole number from -100 to 100. It adds to the profile's phrase bias. A story entry wins over a matching profile entry."
  },
  {
    field: "banned-strings",
    label: "Banned strings",
    help: "One per line. They add to the profile's banned strings."
  }
];

/** The open story's own phrase bias and banned strings (#409 step 9d). They
 * save at once for the story, apart from the settings Save bar, because they
 * belong to the story and not to the settings. */
export function ThisStorySection({ loaded, storyId }: { readonly loaded: LoadedSettings; readonly storyId: string }) {
  const { store, actions } = useAppContext();
  const [story, setStory] = useState<StoryPayload | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const drafts = useStore(store, (state) => state.storyListDrafts[storyId]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const connection = store.get().connection;
    if (connection.kind !== "connected") return undefined;
    let cancelled = false;
    connection.api.loadStory(storyId).then(
      (payload) => {
        if (cancelled) return;
        setStory(payload);
      },
      (error: unknown) => { if (!cancelled) setFailure(errorMessage(error)); }
    );
    return () => { cancelled = true; };
  }, [store, storyId]);

  if (failure !== null) {
    return <Section title="This story"><p className="settings-note">The story did not load: {failure}</p></Section>;
  }
  if (story === null) return null;
  const savedText: Record<Field, string> = {
    "phrase-bias": formatPhraseBiasText(story.phraseBias ?? []),
    "banned-strings": formatBannedStringsText(story.bannedStrings ?? [])
  };
  const texts: Record<Field, string> = {
    "phrase-bias": drafts?.["phrase-bias"] ?? savedText["phrase-bias"],
    "banned-strings": drafts?.["banned-strings"] ?? savedText["banned-strings"]
  };
  const setText = (field: Field, text: string | null): void => {
    store.set((state) => ({
      ...state,
      storyListDrafts: withStoryListDraft(state.storyListDrafts, storyId, field, text === savedText[field] ? null : text)
    }));
  };

  const parsedPhrase = parsePhraseBiasText(texts["phrase-bias"]);
  const parsedBanned = parseBannedStringsText(texts["banned-strings"]);
  const reasons: Record<Field, string | null> = {
    "phrase-bias": parsedPhrase.ok ? null : parsedPhrase.toast,
    "banned-strings": parsedBanned.ok ? null : parsedBanned.toast
  };

  const save = async (field: Field): Promise<void> => {
    const state = store.get();
    const connection = state.connection;
    const refusal = storyChangeRefusal(state, storyId);
    if (connection.kind !== "connected" || refusal !== null) {
      pushToast(store, refusal ?? "Not connected.");
      return;
    }
    const api = connection.api;
    const phrase = parsedPhrase.ok ? parsedPhrase.value : null;
    const banned = parsedBanned.ok ? parsedBanned.value : null;
    setBusy(true);
    const outcome = await runStoryMutation(
      api, storyId,
      async () => ({
        payload: field === "phrase-bias" ? await api.setPhraseBias(storyId, phrase!) : await api.setBannedStrings(storyId, banned!)
      }),
      (reloaded) => {
        const saved = field === "phrase-bias"
          ? formatPhraseBiasText(reloaded.phraseBias ?? []) === formatPhraseBiasText(phrase ?? [])
          : formatBannedStringsText(reloaded.bannedStrings ?? []) === formatBannedStringsText(banned ?? []);
        return saved ? {} : null;
      }
    );
    setBusy(false);
    if (outcome.kind === "saved") {
      setStory(outcome.payload);
      store.set((state) => ({ ...state, storyListDrafts: withStoryListDraft(state.storyListDrafts, storyId, field, null) }));
      actions.story.adoptPayload(storyId, outcome.payload);
      pushToast(store, field === "phrase-bias" ? "Phrase bias saved for this story" : "Banned strings saved for this story");
      return;
    }
    if (outcome.kind !== "unresolved" && outcome.payload !== null) {
      setStory(outcome.payload);
      actions.story.adoptPayload(storyId, outcome.payload);
    }
    pushToast(store, failureToast(outcome, `Saving the ${field === "phrase-bias" ? "phrase bias" : "banned strings"}`, " Your text is kept."));
  };

  const overlay = {
    phraseBias: parsedPhrase.ok ? parsedPhrase.value : (story.phraseBias ?? []),
    bannedStrings: parsedBanned.ok ? parsedBanned.value : (story.bannedStrings ?? [])
  };

  return (
    <Section title="This story">
      <p className="settings-note">Applies to “{story.title}” only. Each list saves for the story at once with its own button.</p>
      {FIELDS.map(({ field, label, help }) => {
        const dirty = texts[field] !== savedText[field];
        const id = `story-${field}`;
        return (
          <Row key={field} label={label} labelId={`${id}-label`} hint={help} error={reasons[field]}>
            <div className="field settings-field">
              <textarea
                aria-labelledby={`${id}-label`}
                className="settings-lines"
                rows={Math.min(8, Math.max(2, texts[field].split("\n").length + 1))}
                value={texts[field]}
                disabled={busy}
                spellCheck={false}
                onChange={(event) => setText(field, event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.currentTarget.blur();
                }}
              />
            </div>
            {dirty && (
              <div className="settings-input-line">
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  title={`Save the ${label.toLowerCase()} for this story`}
                  aria-label={`Save ${label.toLowerCase()} for this story`}
                  disabled={busy || reasons[field] !== null}
                  onClick={() => { void save(field); }}
                >
                  Save for this story
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => setText(field, null)}
                >
                  Revert
                </button>
              </div>
            )}
          </Row>
        );
      })}
      <BiasPreview loaded={loaded} story={overlay} />
    </Section>
  );
}
