import { useEffect, useState } from "react";
import { resolveReferenceBinding } from "../../../shared/reference-bindings.js";
import { WRITING_PROMPT_FIELD_DEFINITIONS, type WritingPromptFieldId } from "../../../shared/settings-v5-writing.js";
import { settingsSubscriptionLoginHint } from "../../../shared/settings-subscription-plan.js";
import { useAppContext } from "../app/context.js";
import { keyEventFromDom } from "../app/keymap-dom.js";
import { pushKeyLayer } from "../app/keymap.js";
import { closeSettings } from "../app/router.js";
import { useStore } from "../app/store.js";
import { GenerationBar } from "../generation/GenerationBar.js";
import { PALETTES } from "../theme/themes.js";
import { Icon, ICONS } from "../ui/icons.js";
import { SidebarToggle } from "../ui/SidebarToggle.js";
import {
  ApiKeyRow,
  Choice,
  ModelRow,
  PromptRow,
  ProviderRow,
  Row,
  Section,
  sectionAnchor,
  TextInputRow
} from "./SettingsFields.js";
import {
  ConnectionAdvancedRows,
  GenerationSection,
  ImageInputRow,
  ProfileRows,
  RoutingSection,
  ThoughtsSection,
  TimeoutRows
} from "./AdvancedSections.js";
import { SaveBar } from "./SaveBar.js";
import { isDirty, isSubscriptionDraft, selectedPreset, targetIdentity } from "./model.js";
import type { LoadedSettings } from "./state.js";

type SettingsViewMode = "simple" | "advanced";
const VIEW_MODE_KEY = "1667.web.settingsView";

/** Simple or advanced: which rows show. It is a browser preference, never
 * part of the settings draft. */
function useViewMode(): readonly [SettingsViewMode, (mode: SettingsViewMode) => void] {
  const [mode, setMode] = useState<SettingsViewMode>(() => {
    try {
      return localStorage.getItem(VIEW_MODE_KEY) === "advanced" ? "advanced" : "simple";
    } catch {
      return "simple";
    }
  });
  return [mode, (next) => {
    setMode(next);
    try {
      localStorage.setItem(VIEW_MODE_KEY, next);
    } catch {
      // The choice then lasts until the page closes.
    }
  }];
}

const READ_ONLY_TEXT: Record<string, string> = {
  "successor-schema": "These settings are newer than this version of 1667 and are read-only here. Update 1667 to change them.",
  "legacy-migration": "These settings use the old data format and are read-only until the data is migrated."
};

/**
 * `#/settings`: the settings page, simple view (#409 step 9b). It replaces the
 * main pane like the map does (the sidebar stays), so a running generation
 * stays stoppable (the bar at the bottom) and the draft stays in the store
 * when the writer leaves. Esc closes the page, also while a generation runs.
 */
export function SettingsPage({ onOpenSidebar }: { readonly onOpenSidebar: () => void }) {
  const { store, actions } = useAppContext();
  const settings = useStore(store, (state) => state.settings);

  useEffect(() => {
    actions.settings.open();
    return actions.settings.leave;
  }, [actions]);

  useEffect(() => pushKeyLayer({
    resolve: (event) => (event.metaKey || event.altKey || event.ctrlKey
      ? null
      : resolveReferenceBinding("global", keyEventFromDom(event), "NAV")),
    claimsEscape: true,
    handle: (binding) => {
      if (binding.action !== "cancel") return false;
      closeSettings();
      return true;
    }
  }), []);

  // Save works inside a field too, where the page's own keys are off.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void actions.settings.save();
      }
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [actions]);

  useEffect(() => {
    const onFocus = (): void => actions.settings.reloadIfClean();
    addEventListener("focus", onFocus);
    return () => removeEventListener("focus", onFocus);
  }, [actions]);

  const [viewMode, setViewMode] = useViewMode();
  const loaded = settings.kind === "loaded" ? settings : null;
  return (
    <div className="story-view settings-page">
      <header className="story-header settings-header">
        <SidebarToggle onOpen={onOpenSidebar} />
        <div className="story-identity">
          <div className="story-title-wrap">
            <h1 className="story-title">Settings</h1>
            {loaded !== null && isDirty(loaded) && (
              <span className="unsaved-dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" />
            )}
          </div>
          <span className="story-stats">Applies to every story in this project</span>
        </div>
        <div className="story-actions">
          <Choice
            label="Settings view"
            value={viewMode}
            options={[{ id: "simple", name: "Simple" }, { id: "advanced", name: "Advanced" }]}
            onSelect={setViewMode}
          />
          <button type="button" className="icon-btn" title="Close (Esc)" aria-label="Close settings (Esc)" onClick={closeSettings}>
            <Icon path={ICONS.x} />
          </button>
        </div>
      </header>
      {settings.kind === "idle" || settings.kind === "loading"
        ? <p className="story-empty">Loading settings…</p>
        : settings.kind === "failed"
          ? (
            <div className="welcome">
              <h1>Settings did not load</h1>
              <p>{settings.message}</p>
              <button type="button" className="btn btn-primary" onClick={actions.settings.retryLoad}>Try again</button>
            </div>
          )
          : <SettingsForm loaded={settings} advanced={viewMode === "advanced"} />}
      {loaded !== null && <SaveBar loaded={loaded} />}
      <GenerationBar />
    </div>
  );
}

function DisplaySection() {
  const { store, actions } = useAppContext();
  const theme = useStore(store, (state) => state.theme);
  const palette = useStore(store, (state) => state.palette);
  const showDirections = useStore(store, (state) => state.reading.showDirections);
  return (
    <Section title="Display">
      <Row label="Palette" labelId="settings-palette" hint="Applies at once, in this browser only.">
        <Choice
          label="Palette"
          value={palette}
          options={PALETTES.map((candidate) => ({ id: candidate.id, name: candidate.name }))}
          onSelect={actions.theme.selectPalette}
        />
      </Row>
      <Row label="Theme" labelId="settings-theme">
        <Choice
          label="Theme"
          value={theme ?? "system"}
          options={[{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }, { id: "system", name: "System" }]}
          onSelect={(id) => actions.theme.setTheme(id === "system" ? null : id)}
        />
      </Row>
      <Row label="Show directions" labelId="settings-directions" hint="Shows the direction that wrote each part.">
        <Choice
          label="Show directions"
          value={showDirections ? "on" : "off"}
          options={[{ id: "on", name: "On" }, { id: "off", name: "Off" }]}
          onSelect={(id) => { if ((id === "on") !== showDirections) actions.story.toggleDirections(); }}
        />
      </Row>
    </Section>
  );
}

function SettingsForm({ loaded, advanced }: { readonly loaded: LoadedSettings; readonly advanced: boolean }) {
  const { store, actions } = useAppContext();
  const editable = loaded.view.editable;
  const locked = !editable || loaded.busy !== null;
  const draft = loaded.draft;
  const dryRun = draft.generation.provider === "dry-run";
  const plan = isSubscriptionDraft(draft);
  const preset = selectedPreset(draft);
  const writing = editable ? draft.document!.writing : loaded.view.activeWriting;
  const target = targetIdentity(loaded);
  const check = loaded.check !== null && loaded.check.target === target ? loaded.check : null;
  const probe = loaded.probe;
  const contextWindow = draft.generation.contextWindow;
  const refusedContext = loaded.invalid.context;
  // A server on plain HTTP needs this opt-in on a system that cannot prove who
  // owns a local port (and for any address that is not local). The row shows
  // only for such an address, so the simple view stays short.
  const ownedLoopbackHttp = useStore(store, (state) => (
    state.connection.kind === "connected" && state.connection.status.ownedLoopbackHttp === true
  ));
  const plainHttp = !dryRun && draft.generation.baseUrl.startsWith("http:");
  const plainHttpHint = ownedLoopbackHttp && isLoopbackUrl(draft.generation.baseUrl)
    ? "Not needed for a local address on this system."
    : "Allows plain HTTP for a server you control. Turn it on for a local or LAN server.";

  const prompts = WRITING_PROMPT_FIELD_DEFINITIONS.filter((definition) => advanced || definition.view === "simple");
  const sections = ["Display", "Prompts", "Connection", "Model", "Generation", "Thoughts", "Routing"];
  const showPlainHttp = advanced ? !dryRun : plainHttp;
  return (
    <div className="settings-scroll">
      <div className={`settings-layout${advanced ? " settings-layout-rail" : ""}`}>
        {advanced && (
          <nav className="settings-rail" aria-label="Sections">
            {sections.map((title) => (
              <button
                key={title}
                type="button"
                className="menu-item"
                title={`Jump to ${title}`}
                onClick={() => document.getElementById(sectionAnchor(title))?.scrollIntoView({ block: "start" })}
              >
                {title}
              </button>
            ))}
          </nav>
        )}
        <div className="settings-body">
          {!editable && (
            <p className="settings-banner" role="status">
              {READ_ONLY_TEXT[loaded.view.readOnlyReason ?? "legacy-migration"]}
            </p>
          )}
          <DisplaySection />
          <Section title="Prompts">
            {prompts.map((definition) => (
              <PromptRow
                key={definition.field}
                definition={definition}
                value={writing[definition.field as WritingPromptFieldId]}
                refused={loaded.invalid[definition.field]}
                disabled={locked}
                onChange={(text) => actions.settings.setWriting(definition.field, text)}
              />
            ))}
          </Section>
          <Section title="Connection">
            <ProviderRow loaded={loaded} />
            {plan && preset !== undefined && (preset === "chatgpt-plan" || preset === "claude-plan") && (
              <p className="settings-note">{settingsSubscriptionLoginHint(preset, loaded.view.subscriptionAuth)}</p>
            )}
            {advanced && <ConnectionAdvancedRows loaded={loaded} />}
            {!plan && (
              <>
                <TextInputRow
                  label="Base URL"
                  value={draft.generation.baseUrl}
                  disabled={locked || dryRun}
                  placeholder={dryRun ? "" : "http://127.0.0.1:1234/v1"}
                  hint={check === null
                    ? dryRun ? "Dry-run needs no server." : "The address of the server, for example http://127.0.0.1:1234/v1."
                    : check.kind === "checking" ? "Checking the server…" : check.result.message}
                  tone={check?.kind === "done" ? (check.result.state === "ready" ? "ready" : "warning") : undefined}
                  extra={(
                    <button
                      type="button"
                      className="btn btn-small"
                      title="Check the connection"
                      disabled={locked || check?.kind === "checking"}
                      onClick={() => { void actions.settings.check(); }}
                    >
                      Check
                    </button>
                  )}
                  onChange={actions.settings.setBaseUrl}
                />
                {showPlainHttp && (
                  <Row label="Plain HTTP" labelId="settings-plain-http" hint={plainHttpHint}>
                    <Choice
                      label="Plain HTTP"
                      value={draft.generation.allowInsecureHttp === true ? "on" : "off"}
                      options={[{ id: "on", name: "On" }, { id: "off", name: "Off" }]}
                      onSelect={(id) => { if (!locked) actions.settings.setAllowInsecureHttp(id === "on"); }}
                    />
                  </Row>
                )}
                <ApiKeyRow loaded={loaded} disabled={locked || dryRun} />
              </>
            )}
            {advanced && <TimeoutRows loaded={loaded} />}
          </Section>
          <Section title="Model">
            {advanced && <ProfileRows loaded={loaded} />}
            <ModelRow loaded={loaded} disabled={locked} dryRun={dryRun} />
            {advanced && <ImageInputRow loaded={loaded} />}
            <TextInputRow
              label="Context size"
              value={contextWindow === null ? "" : String(contextWindow)}
              refused={refusedContext}
              disabled={locked}
              placeholder="Auto"
              hint={probe === null
                ? "How many tokens the model can read. Empty means auto."
                : probe.kind === "probing" ? "Asking the server…" : probe.message}
              tone={probe?.kind === "done" ? (probe.state === "ready" ? "ready" : "warning") : undefined}
              extra={(
                <button
                  type="button"
                  className="btn btn-small"
                  title="Ask the server for the context size"
                  disabled={locked || dryRun || probe?.kind === "probing"}
                  onClick={() => { void actions.settings.probeContext(); }}
                >
                  Probe
                </button>
              )}
              onChange={actions.settings.setContextSize}
            />
          </Section>
          {advanced && (
            <>
              <GenerationSection loaded={loaded} />
              <ThoughtsSection loaded={loaded} />
              <RoutingSection loaded={loaded} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(host);
  } catch {
    return false;
  }
}
