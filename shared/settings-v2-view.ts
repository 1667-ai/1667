import type { ContinuationPromptLayout } from "./continuation-prompt-optimization.js";
import type { GenerationSettings } from "./types.js";
import type {
  ReasoningDisplayV2,
  SettingsActivationOutcomeV2
} from "./settings-v2-types.js";
import type { SettingsDocumentV5 } from "./settings-v5-types.js";
import type { WritingPromptSettings } from "./settings-v5-writing.js";

export type SubscriptionAuthStatus = "signed-in" | "signed-out";

/** Machine-tier sign-in state used by Settings presentation. */
export interface SubscriptionAuthState {
  readonly chatgpt: SubscriptionAuthStatus;
  readonly claude: SubscriptionAuthStatus;
}

/** Why a format-1 settings view cannot be edited by this release. */
export const SETTINGS_VIEW_READ_ONLY_REASON_VALUES = [
  "legacy-migration",
  "successor-schema"
] as const;
export type SettingsViewReadOnlyReason =
  (typeof SETTINGS_VIEW_READ_ONLY_REASON_VALUES)[number];

/** The settings data that a client can read. The continuation layout is an
 * active-route value, never a pending document projection. */
export type SettingsView =
  | {
      readonly dataFormat: 1;
      readonly editable: false;
      /** Absent on older responses; absence means legacy migration. */
      readonly readOnlyReason?: SettingsViewReadOnlyReason;
      readonly stateGeneration: null;
      readonly activeRevision: null;
      readonly pendingRevision: null;
      readonly document: null;
      readonly effective: GenerationSettings;
      /** Read-only machine-tier status for Settings presentation. */
      readonly subscriptionAuth?: SubscriptionAuthState;
      /** Server-certified pristine state for subscription auto-selection. */
      readonly subscriptionAutoSelectEligible?: boolean;
      /** The active continuation route. Format 1 falls back to `effective`. */
      readonly effectiveProse: GenerationSettings;
      /** The active prose route's `GenerationProfileV2.reasoning`, resolved
       *  the same safe way as `effectiveProse` itself — never the editable
       *  `document`, which can show a pending activation candidate while
       *  `effectiveProse` still names the settings actually in force. Absent
       *  means `"marker"`, the same default an absent profile field resolves
       *  to everywhere else. Format 1 has no profile to read one from. */
      readonly effectiveProseReasoning?: ReasoningDisplayV2;
      /** The active prose route's resolved continuation layout. */
      readonly effectiveProseContinuationPromptLayout?: ContinuationPromptLayout;
      /** Active writing prompts. Format 1 uses `effective.systemPrompt` as
       *  Default Author Brief plus schema-5 defaults for the other fields. */
      readonly activeWriting: WritingPromptSettings;
      readonly lastActivationOutcome: null;
    }
  | {
      readonly dataFormat: 2;
      readonly editable: true;
      readonly readOnlyReason?: never;
      readonly stateGeneration: number;
      readonly activeRevision: number;
      readonly pendingRevision: number | null;
      readonly document: SettingsDocumentV5;
      readonly effective: GenerationSettings;
      /** Read-only machine-tier status for Settings presentation. */
      readonly subscriptionAuth?: SubscriptionAuthState;
      /** Server-certified pristine state for subscription auto-selection. */
      readonly subscriptionAutoSelectEligible?: boolean;
      /** The active continuation route, never a pending document projection. */
      readonly effectiveProse: GenerationSettings;
      /** See the format-1 variant's own doc — same field, same resolution. */
      readonly effectiveProseReasoning?: ReasoningDisplayV2;
      /** The active prose route's resolved continuation layout. */
      readonly effectiveProseContinuationPromptLayout?: ContinuationPromptLayout;
      /** Active writing prompts. Schema 2/3/4 project stored Author Brief plus
       *  schema-5 defaults. Schema 5 uses the active revision. */
      readonly activeWriting: WritingPromptSettings;
      readonly lastActivationOutcome: SettingsActivationOutcomeV2 | null;
    };
