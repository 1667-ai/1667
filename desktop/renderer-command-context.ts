import type { StoryApi } from "../client/api.js";
import type { StoryPayload } from "../shared/types.js";
import type { RendererDialogField, RendererState, StreamMode } from "./renderer-model.js";

export interface RendererCommandContext {
  readonly state: () => RendererState;
  readonly api: () => StoryApi;
  readonly story: () => StoryPayload;
  readonly setState: (update: Partial<RendererState>) => void;
  readonly replaceStory: (story: StoryPayload) => Promise<void>;
  readonly continueStory?: (mode: StreamMode, instruction: string, target?: { readonly parentId: string | null }) => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly setDraft: (key: string, value: string | undefined) => void;
  readonly run: (status: string, work: () => Promise<void>) => Promise<void>;
  readonly textDialog: (title: string, value?: string, message?: string, multiline?: boolean) => Promise<string | null>;
  readonly choiceDialog: (title: string, options: readonly string[], value: string) => Promise<string | null>;
  readonly formDialog: (title: string, fields: readonly RendererDialogField[], message?: string) => Promise<Record<string, string> | null>;
  readonly confirmDialog: (title: string, message: string) => Promise<boolean>;
  readonly confirmDiscardDrafts: () => Promise<boolean>;
  readonly discardDrafts: () => Promise<void>;
  readonly getAsideController: () => AbortController | null;
  readonly setAsideController: (controller: AbortController | null) => void;
}
