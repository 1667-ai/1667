import type { StoryApi } from "../client/api.js";
import type { SamplingScalarKnobV2, SettingsView } from "../shared/settings-v2-types.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import {
  makeMutationId,
  type RendererSettingsEditorState,
  type RendererState
} from "./renderer-model.js";
import {
  createSettingsEditorDraft,
  editSamplingList,
  editSamplingScalar,
  editSettingsField as applySettingsField,
  profileRoute,
  type SamplingListName,
  type SettingsEditorDraft,
  type SettingsEditorField,
  type SettingsEditResult
} from "./renderer-settings-model.js";
import {
  addConnectionHeader,
  applyDiscoveredModel,
  clearConnectionSecret,
  createSettingsConnection,
  createSettingsProfile,
  deleteSettingsProfile,
  editConnectionHeader,
  providerProbeTarget,
  removeConnectionHeader,
  renameSettingsProfile,
  setConnectionSecret
} from "./renderer-settings-profile.js";

export interface RendererSettingsHooks {
  readonly state: () => RendererState;
  readonly setState: (update: Partial<RendererState>) => void;
  readonly api: () => StoryApi;
  readonly run: (status: string, work: () => Promise<void>) => Promise<void>;
  readonly textDialog: (title: string, value?: string, message?: string, multiline?: boolean) => Promise<string | null>;
  readonly confirmDialog: (title: string, message: string) => Promise<boolean>;
}

/** Own the typed settings draft and the provider probes used by its editor. */
export class RendererSettingsController {
  private providerActionToken: symbol | null = null;

  public constructor(private readonly hooks: RendererSettingsHooks) {}

  public async load(): Promise<void> {
    this.providerActionToken = null;
    const preferredProfileId = this.editor()?.draft.selectedProfileId;
    const projectKey = this.projectKey();
    await this.hooks.run("Loading settings", async () => {
      const settings = await this.hooks.api().getSettings();
      if (this.projectKey() !== projectKey) return;
      this.hooks.setState({ settings, settingsEditor: createSettingsEditorState(settings, preferredProfileId) });
    });
  }

  public hasDraftChanges(): boolean {
    const settings = this.hooks.state().settings;
    const editor = this.editor();
    return settings !== null && settings.document !== null && editor !== null
      && (JSON.stringify(editor.draft.document) !== JSON.stringify(settings.document)
        || Object.keys(editor.draft.connectionSecrets).length > 0);
  }

  public editField(field: SettingsEditorField, value: string): void {
    const editor = this.editor();
    if (editor === null) return;
    const result = applySettingsField(editor.draft.document, editor.draft.selectedProfileId, field, value);
    this.setEditor({
      ...editor,
      draft: { ...editor.draft, document: result.document },
      fieldErrors: withFieldError(editor.fieldErrors, field, result.error)
    });
  }

  public editSamplingScalar(knob: SamplingScalarKnobV2, value: string): void {
    const editor = this.editor();
    if (editor === null) return;
    const result = editSamplingScalar(editor.draft.document, editor.draft.selectedProfileId, knob, value);
    this.setEditor({
      ...editor,
      draft: { ...editor.draft, document: result.document },
      fieldErrors: withFieldError(editor.fieldErrors, `sampling.${knob}`, result.error)
    });
  }

  public editSamplingList(list: SamplingListName, value: string): void {
    const editor = this.editor();
    if (editor === null) return;
    const result = editSamplingList(editor.draft.document, editor.draft.selectedProfileId, list, value);
    this.setEditor({
      ...editor,
      draft: { ...editor.draft, document: result.document },
      fieldErrors: withFieldError(editor.fieldErrors, `sampling.${list}`, result.error)
    });
  }

  public editHeader(index: number, name: string, env: string): void {
    const editor = this.editor();
    if (editor === null) return;
    const result = editConnectionHeader(editor.draft.document, editor.draft.selectedProfileId, index, name, env);
    this.setEditor({ ...editor, draft: { ...editor.draft, document: result.document }, error: result.error });
  }

  public addHeader(): void {
    const editor = this.editor();
    if (editor !== null) this.applyProfileResult(addConnectionHeader(editor.draft.document, editor.draft.selectedProfileId));
  }

  public removeHeader(index: number): void {
    const editor = this.editor();
    if (editor !== null) this.applyProfileResult(removeConnectionHeader(editor.draft.document, editor.draft.selectedProfileId, index));
  }

  public selectProfile(id: string): void {
    const editor = this.editor();
    if (editor === null || editor.draft.document.profiles[id] === undefined) return;
    this.setEditor({ ...editor, draft: { ...editor.draft, selectedProfileId: id }, fieldErrors: {}, error: null });
  }

  public createProfile(): void {
    const editor = this.editor();
    if (editor !== null) this.applyDraftResult(createSettingsProfile(editor.draft.document, editor.draft.selectedProfileId), editor.draft);
  }

  public createConnection(): void {
    const editor = this.editor();
    if (editor !== null) this.applyDraftResult(createSettingsConnection(editor.draft.document, editor.draft.selectedProfileId), editor.draft);
  }

  public duplicateProfile(): void {
    this.createProfile();
  }

  public async renameProfile(): Promise<void> {
    const editor = this.editor();
    if (editor === null) return;
    const profile = editor.draft.document.profiles[editor.draft.selectedProfileId];
    if (profile === undefined) return;
    const name = await this.hooks.textDialog("Rename profile", profile.name);
    if (name !== null) this.applyProfileResult(renameSettingsProfile(editor.draft.document, editor.draft.selectedProfileId, name));
  }

  public async deleteProfile(): Promise<void> {
    const editor = this.editor();
    if (editor === null) return;
    const profile = editor.draft.document.profiles[editor.draft.selectedProfileId];
    if (profile === undefined || !await this.hooks.confirmDialog("Delete profile", `Delete “${profile.name || editor.draft.selectedProfileId}”?`)) return;
    this.applyDraftResult(deleteSettingsProfile(editor.draft.document, editor.draft.selectedProfileId), editor.draft);
  }

  public setSecret(value: string): void {
    const editor = this.editor();
    if (editor !== null) this.setEditor({ ...editor, draft: setConnectionSecret(editor.draft, value), error: null });
  }

  public clearSecret(): void {
    const editor = this.editor();
    if (editor !== null) this.setEditor({ ...editor, draft: clearConnectionSecret(editor.draft), error: null });
  }

  public useDiscoveredModel(remoteId: string): void {
    const editor = this.editor();
    const model = editor?.discovery.find((candidate) => candidate.remoteId === remoteId);
    if (editor !== null && model !== undefined) this.setEditor({ ...editor, draft: applyDiscoveredModel(editor.draft, model), error: null });
  }

  public async discoverModels(): Promise<void> {
    await this.runProviderAction("discover", async (editor, api, isCurrent) => {
      const result = await api.discoverModels(providerProbeTarget(editor.draft));
      if (!isCurrent()) return;
      const current = this.editor();
      if (current === null) return;
      this.setEditor({ ...current, discovery: result.models, providerStatus: { kind: "ready", message: `Found ${result.models.length} model${result.models.length === 1 ? "" : "s"}.` } });
    });
  }

  public async probeContext(): Promise<void> {
    await this.runProviderAction("probe", async (editor, api, isCurrent) => {
      const result = await api.probeContextWindow(providerProbeTarget(editor.draft));
      if (!isCurrent()) return;
      const current = this.editor();
      if (current === null) return;
      if (result.contextWindow === null) {
        this.setEditor({ ...current, providerStatus: { kind: "warning", message: "The provider did not report a context window." } });
        return;
      }
      const updated = applySettingsField(current.draft.document, current.draft.selectedProfileId, "model.contextWindow", String(result.contextWindow));
      this.setEditor({
        ...current,
        draft: { ...current.draft, document: updated.document },
        fieldErrors: withFieldError(current.fieldErrors, "model.contextWindow", updated.error),
        providerStatus: { kind: "ready", message: `Context window: ${result.contextWindow.toLocaleString()} tokens.` }
      });
    });
  }

  public async checkConnection(): Promise<void> {
    await this.runProviderAction("check", async (editor, api, isCurrent) => {
      const result = await api.checkModelServer(providerProbeTarget(editor.draft));
      if (!isCurrent()) return;
      const current = this.editor();
      if (current !== null) this.setEditor({ ...current, providerStatus: { kind: result.state, message: result.message } });
    });
  }

  public async save(): Promise<void> {
    const editor = this.editor();
    const settings = this.hooks.state().settings;
    if (editor === null || settings === null || !settings.editable) return;
    if (Object.keys(editor.fieldErrors).length > 0) return;
    await this.runProviderAction("save", async (current, api, isCurrent) => {
      await api.saveSettings({
        transportOperationId: makeMutationId("settings-operation"),
        mutationId: createDurableMutationId(),
        expectedStateGeneration: settings.stateGeneration,
        document: current.draft.document,
        ...(Object.keys(current.draft.connectionSecrets).length === 0 ? {} : { connectionSecrets: current.draft.connectionSecrets })
      });
      if (!isCurrent()) return;
      const view = await api.getSettings();
      if (!isCurrent()) return;
      this.hooks.setState({
        settings: view,
        settingsEditor: createSettingsEditorState(view, current.draft.selectedProfileId),
        status: "Settings saved"
      });
    });
  }

  /** Reverts local draft edits to the last-applied document, in memory —
   * no network round trip. Distinct from `discardPending`, which discards a
   * server-side candidate that saved but never activated. */
  public discardDraft(): void {
    const editor = this.editor();
    const settings = this.hooks.state().settings;
    if (editor === null || settings === null) return;
    const restored = createSettingsEditorState(settings, editor.draft.selectedProfileId);
    if (restored !== null) this.setEditor(restored);
  }

  public async discardPending(): Promise<void> {
    const editor = this.editor();
    const settings = this.hooks.state().settings;
    if (editor === null || settings === null || !settings.editable || settings.pendingRevision === null) return;
    await this.runProviderAction("discard", async (current, api, isCurrent) => {
      await api.discardPendingSettings({
        transportOperationId: makeMutationId("settings-operation"),
        mutationId: createDurableMutationId(),
        expectedStateGeneration: settings.stateGeneration
      });
      if (!isCurrent()) return;
      const view = await api.getSettings();
      if (!isCurrent()) return;
      this.hooks.setState({
        settings: view,
        settingsEditor: createSettingsEditorState(view, current.draft.selectedProfileId),
        status: "Pending settings discarded"
      });
    });
  }

  private editor(): RendererSettingsEditorState | null {
    return this.hooks.state().settingsEditor;
  }

  private setEditor(editor: RendererSettingsEditorState): void {
    this.hooks.setState({ settingsEditor: editor });
  }

  private applyDraftResult(result: SettingsEditorDraft | string, previousDraft?: SettingsEditorDraft): void {
    const editor = this.editor();
    if (editor === null) return;
    if (typeof result === "string") this.setEditor({ ...editor, error: result });
    else this.setEditor({ ...editor, draft: preservePendingSecrets(previousDraft ?? editor.draft, result), error: null, fieldErrors: {} });
  }

  private applyProfileResult(result: SettingsEditResult): void {
    const editor = this.editor();
    if (editor !== null) this.setEditor({ ...editor, draft: { ...editor.draft, document: result.document }, error: result.error });
  }

  private async runProviderAction(
    busy: string,
    work: (editor: RendererSettingsEditorState, api: StoryApi, isCurrent: () => boolean) => Promise<void>
  ): Promise<void> {
    const editor = this.editor();
    if (editor === null) return;
    const api = this.hooks.api();
    const projectKey = this.projectKey();
    const route = profileRoute(editor.draft);
    const selectedProfileId = editor.draft.selectedProfileId;
    const providerConnectionId = route.model.connectionId;
    const providerModelId = route.profile.modelId;
    const token = Symbol(busy);
    this.providerActionToken = token;
    const isCurrent = (): boolean => {
      const current = this.editor();
      if (this.providerActionToken !== token
        || current === null
        || this.projectKey() !== projectKey
        || current.draft.selectedProfileId !== selectedProfileId) return false;
      try {
        const currentRoute = profileRoute(current.draft);
        return this.hooks.api() === api
          && currentRoute.model.connectionId === providerConnectionId
          && currentRoute.profile.modelId === providerModelId;
      } catch {
        return false;
      }
    };
    this.setEditor({ ...editor, busy, error: null });
    try {
      await work(editor, api, isCurrent);
    } catch (error) {
      const current = this.editor();
      if (current !== null && isCurrent()) this.setEditor({ ...current, error: error instanceof Error ? error.message : String(error) });
    } finally {
      const current = this.editor();
      if (this.providerActionToken === token) {
        this.providerActionToken = null;
        if (current !== null && current.busy === busy) this.setEditor({ ...current, busy: null });
      }
    }
  }

  private projectKey(): string {
    return JSON.stringify(this.hooks.state().project);
  }
}

export function createSettingsEditorState(settings: SettingsView, preferredProfileId?: string | null): RendererSettingsEditorState | null {
  const draft = createSettingsEditorDraft(settings, preferredProfileId);
  if (draft === null) return null;
  return { draft, discovery: [], busy: null, providerStatus: null, error: null, fieldErrors: {} };
}

function withFieldError(
  errors: Readonly<Record<string, string>>,
  field: string,
  error: string | null
): Readonly<Record<string, string>> {
  const next = { ...errors };
  if (error === null) delete next[field];
  else next[field] = error;
  return next;
}

function preservePendingSecrets(previous: SettingsEditorDraft, next: SettingsEditorDraft): SettingsEditorDraft {
  const referenced = new Set<string>();
  for (const connection of Object.values(next.document.connections)) {
    if (connection.auth.type === "bearer-stored" || connection.auth.type === "header-stored") referenced.add(connection.auth.secretId);
  }
  return {
    ...next,
    connectionSecrets: Object.fromEntries(
      Object.entries(previous.connectionSecrets).filter(([secretId]) => referenced.has(secretId))
    )
  };
}
