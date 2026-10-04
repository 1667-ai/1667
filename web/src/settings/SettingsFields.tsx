import { useId, useState, type ReactNode } from "react";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Icon, ICONS } from "../ui/icons.js";
import { usePopover } from "../ui/usePopover.js";
import type { DiscoveredModelV2 } from "../../../shared/settings-v2-types.js";
import { SETTINGS_PROVIDER_CHOICES } from "../../../shared/settings-provider-choices.js";
import type { WritingPromptFieldDefinition } from "../../../shared/settings-v5-writing.js";
import { currentProviderChoice, keyStatus } from "./model.js";
import { targetIdentity } from "./model.js";
import type { LoadedSettings } from "./state.js";

/** One row: the label, the control, and one hint line. A refused value shows
 * its reason in place of the hint. */
export function Row(
  { label, labelId, hint, error, tone, children }: {
    readonly label: string;
    readonly labelId: string;
    readonly hint?: ReactNode;
    readonly error?: string | null;
    readonly tone?: "ready" | "warning";
    readonly children: ReactNode;
  }
) {
  const message = error ?? hint;
  const toneClass = error !== null && error !== undefined
    ? " settings-hint-danger"
    : tone === "ready" ? " settings-hint-ready" : tone === "warning" ? " settings-hint-danger" : "";
  return (
    <div className="settings-row">
      <div className="settings-label" id={labelId}>{label}</div>
      <div className="settings-control">
        {children}
        {message !== undefined && message !== null && message !== "" && (
          <p className={`settings-hint${toneClass}`} role={error === null || error === undefined ? undefined : "alert"}>
            {message}
          </p>
        )}
      </div>
    </div>
  );
}

/** An opened menu scrolls into view: the page scrolls, and a menu near the end
 * of it would otherwise open below the fold. */
function showMenu(element: HTMLElement | null): void {
  element?.scrollIntoView({ block: "nearest" });
}

/** Esc inside a field only leaves the field; a second Esc closes the page. */
function leaveFieldOnEscape(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.currentTarget.blur();
}

/** Text the writer is typing stays in the field while it has the focus, so a
 * value the draft rewrites (a trailing slash) never fights the typing. */
function useTypedText(value: string, refused: string | undefined) {
  const [typed, setTyped] = useState<string | null>(null);
  return {
    shown: refused ?? typed ?? value,
    type: (text: string) => setTyped(text),
    done: () => setTyped(null)
  };
}

export function TextInputRow(
  { label, value, disabled, hint, refused, tone, placeholder, extra, onChange }: {
    readonly label: string;
    readonly value: string;
    readonly disabled: boolean;
    readonly hint?: ReactNode;
    readonly refused?: { readonly text: string; readonly reason: string } | undefined;
    readonly tone?: "ready" | "warning";
    readonly placeholder?: string;
    /** A button beside the field (Check, Probe). */
    readonly extra?: ReactNode;
    readonly onChange: (text: string) => void;
  }
) {
  const id = useId();
  const labelId = `${id}-label`;
  const text = useTypedText(value, refused?.text);
  return (
    <Row label={label} labelId={labelId} hint={hint} error={refused?.reason ?? null} tone={tone}>
      <div className="settings-input-line">
        <div className="field settings-field">
          <input
            type="text"
            aria-labelledby={labelId}
            value={text.shown}
            disabled={disabled}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => { text.type(event.currentTarget.value); onChange(event.currentTarget.value); }}
            onBlur={text.done}
            onKeyDown={leaveFieldOnEscape}
          />
        </div>
        {extra}
      </div>
    </Row>
  );
}

export function PromptRow(
  { definition, value, refused, disabled, onChange }: {
    readonly definition: WritingPromptFieldDefinition;
    readonly value: string;
    readonly refused: { readonly text: string; readonly reason: string } | undefined;
    readonly disabled: boolean;
    readonly onChange: (text: string) => void;
  }
) {
  const id = useId();
  const labelId = `${id}-label`;
  const text = useTypedText(value, refused?.text);
  const rows = Math.min(12, Math.max(3, text.shown.split("\n").length + 1));
  return (
    <Row label={promptLabel(definition)} labelId={labelId} hint={`${definition.help} ${emptyHelp(definition)}`} error={refused?.reason ?? null}>
      <div className="field settings-field">
        <textarea
          aria-labelledby={labelId}
          className="settings-prompt"
          rows={rows}
          value={text.shown}
          disabled={disabled}
          placeholder={definition.placeholder}
          onChange={(event) => { text.type(event.currentTarget.value); onChange(event.currentTarget.value); }}
          onBlur={text.done}
          onKeyDown={leaveFieldOnEscape}
        />
      </div>
    </Row>
  );
}

function promptLabel(definition: WritingPromptFieldDefinition): string {
  return definition.field === "defaultAuthorBrief"
    ? "Author brief"
    : definition.field === "defaultContinueDirection"
      ? "Continue direction"
      : definition.title;
}

function emptyHelp(definition: WritingPromptFieldDefinition): string {
  return definition.emptyBehavior === "omit-global-brief"
    ? "Empty leaves out the global brief."
    : definition.emptyBehavior === "reset-to-builtin"
      ? "Empty uses the built-in direction."
      : "Empty adds no request block.";
}

/** One closed choice: a button that opens the menu of options. The row's
 * own hint says what the choice does; a refusal replaces it. */
export function SelectRow<T extends string>(
  { label, hint, tone, value, options, disabled, onSelect }: {
    readonly label: string;
    readonly hint?: ReactNode;
    readonly tone?: "ready" | "warning";
    /** What the button shows, which is not always one of the options. */
    readonly value: string;
    readonly options: readonly { readonly id: T; readonly label: string; readonly current: boolean }[];
    readonly disabled: boolean;
    readonly onSelect: (id: T) => void;
  }
) {
  const id = useId();
  const labelId = `${id}-label`;
  const { open, setOpen, containerRef } = usePopover();
  return (
    <Row label={label} labelId={labelId} hint={hint} tone={tone}>
      <div className="settings-popover-wrap" ref={containerRef}>
        <button
          type="button"
          className="btn settings-select"
          id={`${id}-button`}
          aria-labelledby={`${labelId} ${id}-button`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen(!open)}
        >
          <span>{value}</span>
          <Icon path={ICONS.chevronDown} />
        </button>
        {open && (
          <div ref={showMenu} className="menu settings-menu" role="menu" aria-label={label}>
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={option.current}
                className={`menu-item${option.current ? " settings-menu-current" : ""}`}
                onClick={() => { onSelect(option.id); setOpen(false); }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </Row>
  );
}

export function ProviderRow({ loaded }: { readonly loaded: LoadedSettings }) {
  const { actions } = useAppContext();
  const choice = currentProviderChoice(loaded.draft);
  return (
    <SelectRow
      label="Provider"
      hint="Where the writing comes from. Dry-run writes sample text and needs no server."
      value={choice.label}
      options={SETTINGS_PROVIDER_CHOICES.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        current: candidate.id === choice.id
      }))}
      disabled={!loaded.view.editable || loaded.busy !== null}
      onSelect={actions.settings.chooseProvider}
    />
  );
}

/** A short choice as a segmented control. */
export function Choice<T extends string>(
  { label, value, options, disabled, onSelect }: {
    readonly label: string;
    readonly value: T;
    readonly options: readonly { readonly id: T; readonly name: string }[];
    readonly disabled?: boolean;
    readonly onSelect: (id: T) => void;
  }
) {
  return (
    <div className="settings-choice" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="chip-btn"
          aria-pressed={option.id === value}
          disabled={disabled}
          onClick={() => onSelect(option.id)}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}

/** A choice between on and off, as a row. */
export function ToggleRow(
  { label, hint, tone, on, disabled, onChange }: {
    readonly label: string;
    readonly hint?: ReactNode;
    readonly tone?: "ready" | "warning";
    readonly on: boolean;
    readonly disabled: boolean;
    readonly onChange: (on: boolean) => void;
  }
) {
  const labelId = `${useId()}-label`;
  return (
    <Row label={label} labelId={labelId} hint={hint} tone={tone}>
      <Choice
        label={label}
        value={on ? "on" : "off"}
        disabled={disabled}
        options={[{ id: "on", name: "On" }, { id: "off", name: "Off" }]}
        onSelect={(id) => onChange(id === "on")}
      />
    </Row>
  );
}

export function ApiKeyRow({ loaded, disabled }: { readonly loaded: LoadedSettings; readonly disabled: boolean }) {
  const { actions } = useAppContext();
  const id = useId();
  const labelId = `${id}-label`;
  const status = keyStatus({ draft: loaded.draft, secrets: loaded.secrets });
  const refused = loaded.invalid["api-key"];
  const hint = status.kind === "env"
    ? `This provider reads the key from the ${status.name} environment variable. Type a key to store one instead.`
    : status.kind === "pending"
      ? "The key is not saved yet. It is stored on this computer when you save."
      : status.kind === "stored"
        ? "A key is stored on this computer. It is never shown again. Type a new key to replace it."
        : "The key is stored on this computer. It is never shown again.";
  return (
    <Row label="API key" labelId={labelId} hint={hint} error={refused?.reason ?? null}>
      <div className="settings-input-line">
        <div className="field settings-field">
          {/* Uncontrolled and never given a value: the key goes to the draft's
              write-only sidecar and nowhere else, and a save, a discard or a
              removal starts this field empty by changing its `key`. */}
          <input
            key={loaded.keyEpoch}
            type="password"
            aria-labelledby={labelId}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            placeholder={status.kind === "stored" ? "Replace the stored key" : "Paste an API key"}
            onChange={(event) => actions.settings.setApiKey(event.currentTarget.value)}
            onKeyDown={leaveFieldOnEscape}
          />
        </div>
        {status.kind === "stored" && <span className="label-chip settings-stored">Stored</span>}
        {(status.kind === "stored" || status.kind === "pending") && (
          <button
            type="button"
            className="btn btn-small"
            title="Remove the stored key when you save"
            disabled={disabled}
            onClick={actions.settings.removeApiKey}
          >
            Remove
          </button>
        )}
      </div>
    </Row>
  );
}

export function ModelRow({ loaded, disabled, dryRun }: {
  readonly loaded: LoadedSettings;
  readonly disabled: boolean;
  readonly dryRun: boolean;
}) {
  const { actions } = useAppContext();
  const id = useId();
  const labelId = `${id}-label`;
  const { open, setOpen, containerRef } = usePopover();
  const typedState = useTypedText(loaded.draft.generation.model, undefined);
  const discovery = loaded.discovery !== null && loaded.discovery.target === targetIdentity(loaded) ? loaded.discovery : null;
  const models: readonly DiscoveredModelV2[] = discovery?.kind === "ready" ? discovery.models : [];
  const needle = typedState.shown.trim().toLowerCase();
  const exact = models.some((model) => model.remoteId.toLowerCase() === needle);
  const shownModels = needle.length === 0 || exact
    ? models
    : models.filter((model) => model.remoteId.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle));
  const hint = dryRun
    ? "Dry-run needs no model."
    : discovery === null ? "Type the model name."
      : discovery.kind === "loading" ? "Reading the model list…"
        : discovery.kind === "failed" ? `The model list is not available: ${discovery.message} Type the model name.`
          : models.length === 0 ? "The server lists no models. Type the model name."
            : `${models.length.toLocaleString("en-US")} ${models.length === 1 ? "model" : "models"} listed. Pick one, or type a name.`;
  return (
    <Row label="Model" labelId={labelId} hint={hint} tone={discovery?.kind === "failed" ? "warning" : undefined}>
      <div className="settings-popover-wrap" ref={containerRef}>
        <div className="settings-input-line">
          <div className="field settings-field">
            <input
              type="text"
              role="combobox"
              aria-labelledby={labelId}
              aria-expanded={open && shownModels.length > 0}
              aria-autocomplete="list"
              aria-controls={`${id}-list`}
              value={typedState.shown}
              disabled={disabled || dryRun}
              spellCheck={false}
              autoComplete="off"
              onFocus={() => setOpen(true)}
              onChange={(event) => { typedState.type(event.currentTarget.value); setOpen(true); actions.settings.setModel(event.currentTarget.value); }}
              onBlur={typedState.done}
              onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); } leaveFieldOnEscape(event); }}
            />
          </div>
          <button
            type="button"
            className="icon-btn"
            title="Reload the model list"
            aria-label="Reload the model list"
            disabled={disabled || dryRun || discovery?.kind === "loading"}
            onClick={actions.settings.refreshModels}
          >
            <Icon path={ICONS.rotate} />
          </button>
        </div>
        {open && shownModels.length > 0 && (
          <div ref={showMenu} className="menu settings-menu" role="listbox" id={`${id}-list`} aria-label="Models">
            {shownModels.map((model) => (
              <button
                key={model.remoteId}
                type="button"
                role="option"
                aria-selected={model.remoteId === loaded.draft.generation.model}
                className={`menu-item${model.remoteId === loaded.draft.generation.model ? " settings-menu-current" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { actions.settings.pickModel(model); typedState.done(); setOpen(false); }}
              >
                <span className="menu-item-text">{model.remoteId}</span>
                {model.contextWindow !== null && <span className="menu-key">{model.contextWindow.toLocaleString("en-US")}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </Row>
  );
}

export function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="settings-section" aria-label={title} id={sectionAnchor(title)}>
      <h2 className="settings-heading">{title}</h2>
      {children}
    </section>
  );
}

/** The element id the section list scrolls to. */
export function sectionAnchor(title: string): string {
  return `settings-section-${title.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;
}

/** A list as lines in one field. A refused text stays with its reason. */
export function LinesRow(
  { label, value, refused, disabled, hint, tone, placeholder, onChange }: {
    readonly label: string;
    readonly value: string;
    readonly refused: { readonly text: string; readonly reason: string } | undefined;
    readonly disabled: boolean;
    readonly hint?: ReactNode;
    readonly tone?: "ready" | "warning";
    readonly placeholder?: string;
    readonly onChange: (text: string) => void;
  }
) {
  const id = useId();
  const labelId = `${id}-label`;
  const text = useTypedText(value, refused?.text);
  const rows = Math.min(8, Math.max(2, text.shown.split("\n").length + 1));
  return (
    <Row label={label} labelId={labelId} hint={hint} error={refused?.reason ?? null} tone={tone}>
      <div className="field settings-field">
        <textarea
          aria-labelledby={labelId}
          className="settings-lines"
          rows={rows}
          value={text.shown}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => { text.type(event.currentTarget.value); onChange(event.currentTarget.value); }}
          onBlur={text.done}
          onKeyDown={leaveFieldOnEscape}
        />
      </div>
    </Row>
  );
}
