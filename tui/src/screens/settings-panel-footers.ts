import type { KeyAction } from "../keys.js";
import {
  boundedSettingsCursor,
  settingsRowHasArrows,
  settingsRowIds
} from "../settings-overlay-model.js";
import { isSettingsScalarRow } from "../settings-scalar.js";
import { modelPickerRequired } from "../settings-model-picker.js";
import { settingsSubscriptionPreset } from "../settings-subscription.js";
import type { SettingsOverlayState } from "../state.js";
import { visibleWidth } from "./story/frame.js";

/** Footer variants for the settings panel, widest first.
 *
 * Each mode of the panel has its own list. `fittingFooter` takes the first
 * variant that fits the panel, so a narrow panel loses words before it loses
 * keys. The tokens are click targets, so the text and the actions must stay in
 * the same order. */
export interface SettingsFooter {
  text: string;
  actions: ReadonlyArray<{ token: string; action: KeyAction }>;
}

export function fittingFooter(
  variants: ReadonlyArray<SettingsFooter>,
  availableWidth: number
): SettingsFooter {
  return variants.find((variant) => visibleWidth(variant.text) <= availableWidth)
    ?? variants.at(-1)!;
}

function withoutPlanProbes(
  variants: ReadonlyArray<SettingsFooter>
): ReadonlyArray<SettingsFooter> {
  return variants.map((variant) => {
    const probes = variant.actions.filter((entry) =>
      entry.action === "check" || entry.action === "detect-context"
    );
    const text = probes.reduce((current, entry) => current
      .replace(` · ${entry.token} · `, " · ")
      .replace(` ${entry.token} `, " "), variant.text);
    return {
      text,
      actions: variant.actions.filter((entry) =>
        entry.action !== "check" && entry.action !== "detect-context"
      )
    };
  });
}

/** Simple/advanced view toggle. Shown only in the widest footer variant of
 *  each keyline — the same "narrow terminal loses words before it loses
 *  keys" tier every other rarely-critical verb (`x discard`, `i import`)
 *  already skips in the medium and terse variants below. */
const VIEW_MODE_TOGGLE = {
  token: "m mode", action: "toggle-view-mode"
} as const satisfies { token: string; action: KeyAction };

/** Name the view the toggle will open, so the footer states its action. */
function withViewModeActionLabel(
  variants: ReadonlyArray<SettingsFooter>,
  viewMode: SettingsOverlayState["viewMode"]
): ReadonlyArray<SettingsFooter> {
  const token = viewMode === "advanced" ? "m simple" : "m advanced";
  return variants.map((variant) => ({
    text: variant.text.replace("m mode", token),
    actions: variant.actions.map((entry) => entry.action === "toggle-view-mode"
      ? { ...entry, token }
      : entry)
  }));
}

function withOpenSelectedActionLabel(
  variants: ReadonlyArray<SettingsFooter>,
  label: string
): ReadonlyArray<SettingsFooter> {
  return variants.map((variant) => ({
    text: variant.text.replace("↵ edit", label),
    actions: variant.actions.map((entry) => entry.action === "open-selected"
      ? { ...entry, token: entry.token.replace("↵ edit", label) }
      : entry)
  }));
}

/** `esc close`'s abbreviated form, paired with `VIEW_MODE_TOGGLE` in every
 *  widest-tier variant that carries it — not just the ones that need the
 *  width back, so the panel never shows "esc" in one keyline and "esc
 *  close" in another. Adding the view-mode toggle pushed the choice,
 *  model, and context keylines' widest variant past 80 columns' footer
 *  budget, so that width fell straight through to the medium tier — which
 *  drops the toggle entirely — hiding the one discovery affordance for the
 *  feature that changed the default view. Shortening this token (already
 *  how `esc` reads in every narrower tier) reclaims enough width to keep
 *  the full keyline, toggle included, at 80 columns. */
const CANCEL_SHORT = { token: "esc", action: "cancel" } as const satisfies { token: string; action: KeyAction };

export const SETTINGS_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" },
  { token: "↓", action: "focus-next" },
  { token: "←", action: "take-previous" },
  { token: "→ choose", action: "take-next" },
  { token: "↵ next", action: "open-selected" },
  { token: "s save", action: "save-edit" },
  { token: "c check", action: "check" },
  VIEW_MODE_TOGGLE,
  CANCEL_SHORT
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const SETTINGS_TEXT_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" },
  { token: "↓", action: "focus-next" },
  { token: "↵ edit", action: "open-selected" },
  { token: "s save", action: "save-edit" },
  { token: "c check", action: "check" },
  VIEW_MODE_TOGGLE,
  CANCEL_SHORT
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const SETTINGS_CONTEXT_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" },
  { token: "↓", action: "focus-next" },
  { token: "↵ edit", action: "open-selected" },
  { token: "p detect", action: "detect-context" },
  { token: "s save", action: "save-edit" },
  { token: "c check", action: "check" },
  VIEW_MODE_TOGGLE,
  CANCEL_SHORT
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const SETTINGS_EDIT_FOOTER_ACTIONS = [
  { token: "←", action: "cursor-left" },
  { token: "→", action: "cursor-right" },
  { token: "↵ keep", action: "commit-field" },
  { token: "esc cancel", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

// A staged candidate stays fully editable: the pending footers keep the
// normal editing keys and add the discard.
const SETTINGS_PENDING_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" },
  { token: "↓", action: "focus-next" },
  { token: "↵ edit", action: "open-selected" },
  { token: "s save", action: "save-edit" },
  { token: "c check", action: "check" },
  { token: "x discard", action: "discard-pending" },
  VIEW_MODE_TOGGLE,
  CANCEL_SHORT
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

export const SETTINGS_CHOICE_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ←→ choose · ↵ next · s save · c check · m mode · esc",
    actions: SETTINGS_FOOTER_ACTIONS
  },
  {
    text: "↑↓ · ←→ choose · ↵ next · s · c · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ choose", action: "take-next" },
      { token: "↵ next", action: "open-selected" },
      { token: "s", action: "save-edit" },
      { token: "c", action: "check" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ←→ ↵ esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→", action: "take-next" },
      { token: "↵", action: "open-selected" },
      { token: "esc", action: "cancel" }
    ]
  }
];

export const SETTINGS_MODEL_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ · ←→ choose · ↵ custom · s save · c check · m mode · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ choose", action: "take-next" },
      { token: "↵ custom", action: "open-selected" },
      { token: "s save", action: "save-edit" },
      { token: "c check", action: "check" },
      VIEW_MODE_TOGGLE,
      CANCEL_SHORT
    ]
  },
  {
    text: "↑↓ · ←→ choose · ↵ custom · s · c · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ choose", action: "take-next" },
      { token: "↵ custom", action: "open-selected" },
      { token: "s", action: "save-edit" },
      { token: "c", action: "check" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ←→ ↵ esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→", action: "take-next" },
      { token: "↵", action: "open-selected" },
      { token: "esc", action: "cancel" }
    ]
  }
];

export const SETTINGS_PROFILE_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ←→ profile · n new · ⇧n copy · i import · e rename · D delete · s save · m mode · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ profile", action: "take-next" },
      { token: "n new", action: "new-item" },
      { token: "⇧n copy", action: "duplicate-item" },
      { token: "i import", action: "import-profile" },
      { token: "e rename", action: "edit" },
      { token: "D delete", action: "delete-item" },
      { token: "s save", action: "save-edit" },
      VIEW_MODE_TOGGLE,
      CANCEL_SHORT
    ]
  },
  {
    text: "↑↓ · ←→ profile · n new · ⇧n copy · i import · e rename · D delete · s · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ profile", action: "take-next" },
      { token: "n new", action: "new-item" },
      { token: "⇧n copy", action: "duplicate-item" },
      { token: "i import", action: "import-profile" },
      { token: "e rename", action: "edit" },
      { token: "D delete", action: "delete-item" },
      { token: "s", action: "save-edit" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ←→ n N i e D s esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→", action: "take-next" },
      { token: "n", action: "new-item" },
      { token: "N", action: "duplicate-item" },
      { token: "i", action: "import-profile" },
      { token: "e", action: "edit" },
      { token: "D", action: "delete-item" },
      { token: "s", action: "save-edit" },
      { token: "esc", action: "cancel" }
    ]
  }
];

const SETTINGS_DELETE_CONFIRM_FOOTERS: ReadonlyArray<SettingsFooter> = [{
  text: "D confirms · esc keeps",
  actions: [
    { token: "D confirms", action: "delete-item" },
    { token: "esc keeps", action: "cancel" }
  ]
}];

/** A pending candidate does not remove profile management. Keep its discard
 * command visible with the profile verbs, because both affect the same draft. */
export const SETTINGS_PENDING_PROFILE_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ←→ profile · n new · ⇧n copy · i import · e rename · D delete · s save · x discard · m mode · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ profile", action: "take-next" },
      { token: "n new", action: "new-item" },
      { token: "⇧n copy", action: "duplicate-item" },
      { token: "i import", action: "import-profile" },
      { token: "e rename", action: "edit" },
      { token: "D delete", action: "delete-item" },
      { token: "s save", action: "save-edit" },
      { token: "x discard", action: "discard-pending" },
      VIEW_MODE_TOGGLE,
      CANCEL_SHORT
    ]
  },
  {
    text: "↑↓ · ←→ profile · n new · ⇧n copy · i import · e rename · D delete · s · x · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ profile", action: "take-next" },
      { token: "n new", action: "new-item" },
      { token: "⇧n copy", action: "duplicate-item" },
      { token: "i import", action: "import-profile" },
      { token: "e rename", action: "edit" },
      { token: "D delete", action: "delete-item" },
      { token: "s", action: "save-edit" },
      { token: "x", action: "discard-pending" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ←→ n N i e D s x esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→", action: "take-next" },
      { token: "n", action: "new-item" },
      { token: "N", action: "duplicate-item" },
      { token: "i", action: "import-profile" },
      { token: "e", action: "edit" },
      { token: "D", action: "delete-item" },
      { token: "s", action: "save-edit" },
      { token: "x", action: "discard-pending" },
      { token: "esc", action: "cancel" }
    ]
  }
];

export const SETTINGS_TEXT_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ↵ edit · s save · c check · m mode · esc",
    actions: SETTINGS_TEXT_FOOTER_ACTIONS
  },
  {
    text: "↑↓ · ↵ edit · s · c · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "↵ edit", action: "open-selected" },
      { token: "s", action: "save-edit" },
      { token: "c", action: "check" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ↵ esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "↵", action: "open-selected" },
      { token: "esc", action: "cancel" }
    ]
  }
];

const SETTINGS_MODEL_PICKER_FOOTERS = withOpenSelectedActionLabel(
  SETTINGS_TEXT_FOOTERS,
  "↵ choose"
);

/** C-15 owns `↑↓` and every letter, so the column advertises only what it
 *  actually answers. */
export const SETTINGS_PICKER_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · type to narrow · ↵ choose · esc back",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "↵ choose", action: "open-selected" },
      { token: "esc back", action: "cancel" }
    ]
  },
  {
    text: "↑↓ · ↵ choose · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "↵ choose", action: "open-selected" },
      { token: "esc", action: "cancel" }
    ]
  }
];

/** A C-08 scalar owns `←→`, `⇧` and `↵`, so its keyline says so rather than
 *  borrowing the cycler's `choose`. */
export const SETTINGS_SCALAR_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ←→ step · ⇧ ×10 · ↵ type · s save · m mode · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ step", action: "take-next" },
      { token: "↵ type", action: "open-selected" },
      { token: "s save", action: "save-edit" },
      VIEW_MODE_TOGGLE,
      CANCEL_SHORT
    ]
  },
  {
    text: "↑↓ · ←→ step · ↵ type · s · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ step", action: "take-next" },
      { token: "↵ type", action: "open-selected" },
      { token: "s", action: "save-edit" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ←→ ↵ esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→", action: "take-next" },
      { token: "↵", action: "open-selected" },
      { token: "esc", action: "cancel" }
    ]
  }
];

export const SETTINGS_CONTEXT_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ←→ step · ↵ type · p detect · s save · m mode · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ step", action: "take-next" },
      { token: "↵ type", action: "open-selected" },
      { token: "p detect", action: "detect-context" },
      { token: "s save", action: "save-edit" },
      VIEW_MODE_TOGGLE,
      CANCEL_SHORT
    ]
  },
  {
    text: "↑↓ move · ↵ edit · p detect · s save · c check · m mode · esc",
    actions: SETTINGS_CONTEXT_FOOTER_ACTIONS
  },
  {
    text: "↑↓ · ↵ edit · p detect · s · c · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "↵ edit", action: "open-selected" },
      { token: "p detect", action: "detect-context" },
      { token: "s", action: "save-edit" },
      { token: "c", action: "check" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ↵ p esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "↵", action: "open-selected" },
      { token: "p", action: "detect-context" },
      { token: "esc", action: "cancel" }
    ]
  }
];

export const SETTINGS_EDIT_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "←→ cursor · ↵ keep row · esc cancel",
    actions: SETTINGS_EDIT_FOOTER_ACTIONS
  },
  {
    text: "←→ · ↵ keep · esc",
    actions: [
      { token: "←", action: "cursor-left" },
      { token: "→", action: "cursor-right" },
      { token: "↵ keep", action: "commit-field" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "←→ ↵ esc",
    actions: [
      { token: "←", action: "cursor-left" },
      { token: "→", action: "cursor-right" },
      { token: "↵", action: "commit-field" },
      { token: "esc", action: "cancel" }
    ]
  }
];

export const SETTINGS_PENDING_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ↵ edit · s save · c check · x discard · m mode · esc",
    actions: SETTINGS_PENDING_FOOTER_ACTIONS
  },
  {
    text: "↑↓ · ↵ edit · s · c · x · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "↵ edit", action: "open-selected" },
      { token: "s", action: "save-edit" },
      { token: "c", action: "check" },
      { token: "x", action: "discard-pending" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ↵ s c x esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "↵", action: "open-selected" },
      { token: "s", action: "save-edit" },
      { token: "c", action: "check" },
      { token: "x", action: "discard-pending" },
      { token: "esc", action: "cancel" }
    ]
  }
];

const SETTINGS_PENDING_MODEL_PICKER_FOOTERS = withOpenSelectedActionLabel(
  SETTINGS_PENDING_FOOTERS,
  "↵ choose"
);

/** Which keyline this panel shows. Footer policy follows the row model, so it
 *  lives with the footers rather than as a ternary chain in the renderer. */
export function settingsFooterVariants(
  overlay: SettingsOverlayState,
  pickerOpen: boolean
): ReadonlyArray<SettingsFooter> {
  if (pickerOpen) return SETTINGS_PICKER_FOOTERS;
  if (overlay.edit !== null) return SETTINGS_EDIT_FOOTERS;
  if (overlay.deleteArmedProfileId !== null) return SETTINGS_DELETE_CONFIRM_FOOTERS;
  const row = settingsRowIds(overlay)[boundedSettingsCursor(overlay.cursor, overlay)]!;
  const pending = overlay.view.editable && overlay.view.pendingRevision !== null;
  let variants: ReadonlyArray<SettingsFooter>;
  if (row === "profile") {
    variants = pending ? SETTINGS_PENDING_PROFILE_FOOTERS : SETTINGS_PROFILE_FOOTERS;
  } else if (pending) variants = row === "model" && modelPickerRequired(overlay)
    ? SETTINGS_PENDING_MODEL_PICKER_FOOTERS
    : SETTINGS_PENDING_FOOTERS;
  // The context window is a scalar that can also be probed, so it keeps its
  // own keyline rather than the plain scalar one.
  else if (row === "context-window") variants = SETTINGS_CONTEXT_FOOTERS;
  else if (isSettingsScalarRow(row)) variants = SETTINGS_SCALAR_FOOTERS;
  else if (row === "model" && modelPickerRequired(overlay)) variants = SETTINGS_MODEL_PICKER_FOOTERS;
  else if (!settingsRowHasArrows(overlay, row)) variants = SETTINGS_TEXT_FOOTERS;
  else variants = row === "model" ? SETTINGS_MODEL_FOOTERS : SETTINGS_CHOICE_FOOTERS;
  const footerVariants = settingsSubscriptionPreset(overlay) === null
    ? variants
    : withoutPlanProbes(variants);
  return withViewModeActionLabel(footerVariants, overlay.viewMode);
}
