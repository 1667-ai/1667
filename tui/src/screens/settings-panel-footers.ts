import type { KeyAction } from "../keys.js";
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

export const SETTINGS_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" },
  { token: "↓", action: "focus-next" },
  { token: "←", action: "take-previous" },
  { token: "→ choose", action: "take-next" },
  { token: "↵ next", action: "open-selected" },
  { token: "s save", action: "save-edit" },
  { token: "c check", action: "check" },
  { token: "esc close", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const SETTINGS_TEXT_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" },
  { token: "↓", action: "focus-next" },
  { token: "↵ edit", action: "open-selected" },
  { token: "s save", action: "save-edit" },
  { token: "c check", action: "check" },
  { token: "esc close", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

const SETTINGS_CONTEXT_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" },
  { token: "↓", action: "focus-next" },
  { token: "↵ edit", action: "open-selected" },
  { token: "p detect", action: "detect-context" },
  { token: "s save", action: "save-edit" },
  { token: "c check", action: "check" },
  { token: "esc close", action: "cancel" }
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
  { token: "esc close", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;

export const SETTINGS_CHOICE_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ←→ choose · ↵ next · s save · c check · esc close",
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
    text: "↑↓ move · ←→ choose · ↵ custom · s save · c check · esc close",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ choose", action: "take-next" },
      { token: "↵ custom", action: "open-selected" },
      { token: "s save", action: "save-edit" },
      { token: "c check", action: "check" },
      { token: "esc close", action: "cancel" }
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
    text: "↑↓ move · ←→ profile · n new · ⇧n copy · e rename · d delete · s save · esc close",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ profile", action: "take-next" },
      { token: "n new", action: "new-item" },
      { token: "⇧n copy", action: "duplicate-item" },
      { token: "e rename", action: "edit" },
      { token: "d delete", action: "delete-item" },
      { token: "s save", action: "save-edit" },
      { token: "esc close", action: "cancel" }
    ]
  },
  {
    text: "↑↓ · ←→ profile · n new · ⇧n copy · e rename · d delete · s · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ profile", action: "take-next" },
      { token: "n new", action: "new-item" },
      { token: "⇧n copy", action: "duplicate-item" },
      { token: "e rename", action: "edit" },
      { token: "d delete", action: "delete-item" },
      { token: "s", action: "save-edit" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ←→ n N e d s esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→", action: "take-next" },
      { token: "n", action: "new-item" },
      { token: "N", action: "duplicate-item" },
      { token: "e", action: "edit" },
      { token: "d", action: "delete-item" },
      { token: "s", action: "save-edit" },
      { token: "esc", action: "cancel" }
    ]
  }
];

/** A pending candidate does not remove profile management. Keep its discard
 * command visible with the profile verbs, because both affect the same draft. */
export const SETTINGS_PENDING_PROFILE_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ←→ profile · n new · ⇧n copy · e rename · d delete · s save · x discard · esc close",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ profile", action: "take-next" },
      { token: "n new", action: "new-item" },
      { token: "⇧n copy", action: "duplicate-item" },
      { token: "e rename", action: "edit" },
      { token: "d delete", action: "delete-item" },
      { token: "s save", action: "save-edit" },
      { token: "x discard", action: "discard-pending" },
      { token: "esc close", action: "cancel" }
    ]
  },
  {
    text: "↑↓ · ←→ profile · n new · ⇧n copy · e rename · d delete · s · x · esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ profile", action: "take-next" },
      { token: "n new", action: "new-item" },
      { token: "⇧n copy", action: "duplicate-item" },
      { token: "e rename", action: "edit" },
      { token: "d delete", action: "delete-item" },
      { token: "s", action: "save-edit" },
      { token: "x", action: "discard-pending" },
      { token: "esc", action: "cancel" }
    ]
  },
  {
    text: "↑↓ ←→ n N e d s x esc",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→", action: "take-next" },
      { token: "n", action: "new-item" },
      { token: "N", action: "duplicate-item" },
      { token: "e", action: "edit" },
      { token: "d", action: "delete-item" },
      { token: "s", action: "save-edit" },
      { token: "x", action: "discard-pending" },
      { token: "esc", action: "cancel" }
    ]
  }
];

export const SETTINGS_TEXT_FOOTERS: ReadonlyArray<SettingsFooter> = [
  {
    text: "↑↓ move · ↵ edit · s save · c check · esc close",
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
    text: "↑↓ move · ←→ step · ⇧ ×10 · ↵ type · s save · esc close",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ step", action: "take-next" },
      { token: "↵ type", action: "open-selected" },
      { token: "s save", action: "save-edit" },
      { token: "esc close", action: "cancel" }
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
    text: "↑↓ move · ←→ step · ↵ type · p detect · s save · esc close",
    actions: [
      { token: "↑", action: "focus-previous" },
      { token: "↓", action: "focus-next" },
      { token: "←", action: "take-previous" },
      { token: "→ step", action: "take-next" },
      { token: "↵ type", action: "open-selected" },
      { token: "p detect", action: "detect-context" },
      { token: "s save", action: "save-edit" },
      { token: "esc close", action: "cancel" }
    ]
  },
  {
    text: "↑↓ move · ↵ edit · p detect · s save · c check · esc close",
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
    text: "↑↓ move · ↵ edit · s save · c check · x discard · esc close",
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
