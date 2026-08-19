import type { ContinuationPromptLayout } from "./continuation-prompt-optimization.js";
import type { GenerationSettings } from "./types.js";
import type {
  ReasoningDisplayV2,
  SettingsActivationOutcomeV2,
  SettingsDocumentV2
} from "./settings-v2-types.js";

export type SubscriptionAuthStatus = "signed-in" | "signed-out";

/** Machine-tier sign-in state used by Settings presentation. */
export interface SubscriptionAuthState {
  readonly chatgpt: SubscriptionAuthStatus;
  readonly claude: SubscriptionAuthStatus;
}

/** The settings data that a client can read. The continuation layout is an
 * active-route value, never a pending document projection. */
export type SettingsView =
  | {
      readonly dataFormat: 1;
      readonly editable: false;
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
      readonly lastActivationOutcome: null;
    }
  | {
      readonly dataFormat: 2;
      readonly editable: true;
      readonly stateGeneration: number;
      readonly activeRevision: number;
      readonly pendingRevision: number | null;
      readonly document: SettingsDocumentV2;
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
      readonly lastActivationOutcome: SettingsActivationOutcomeV2 | null;
    };
