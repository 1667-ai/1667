export type SettingsActivationMode = "activation-capable" | "recover-only";

export const SETTINGS_SAVE_CRASH_HOOK_NAMES = [
  "afterPendingSecretsOwnership",
  "afterSecretValueWrite",
  "afterReceiptPrepared",
  "afterNextStaged",
  "afterCurrentPublished",
  "afterReceiptCompleted",
  "afterSecretCleanup"
] as const;

export type SettingsSaveCrashHookName = (typeof SETTINGS_SAVE_CRASH_HOOK_NAMES)[number];

export type SettingsSaveHooks = {
  readonly [Hook in SettingsSaveCrashHookName]?: () => void | Promise<void>;
};

export async function runSettingsSaveHook(
  hooks: SettingsSaveHooks | undefined,
  name: SettingsSaveCrashHookName
): Promise<void> {
  await hooks?.[name]?.();
}
