import { describe, expect, test } from "bun:test";
import type { SettingsView } from "../../shared/settings-v2-types.js";
import {
  effortRowHint,
  effortRowValue,
  profileRowHint,
  profileRowValue
} from "../src/settings-profile-controls.js";
import {
  initialSettingsOverlay,
  settingsRows
} from "../src/settings-overlay-model.js";
import { settingsSubscriptionPreset } from "../src/settings-subscription.js";
import { settingsHarness } from "./settings-test-harness.js";

type ReadOnlySettingsView = Extract<SettingsView, { dataFormat: 1 }>;

function readOnlyView(
  source: ReturnType<typeof settingsHarness>["source"],
  overrides: Partial<ReadOnlySettingsView> = {}
): ReadOnlySettingsView {
  return {
    dataFormat: 1,
    editable: false,
    stateGeneration: null,
    activeRevision: null,
    pendingRevision: null,
    document: null,
    effective: source.settingsView.effective,
    effectiveProse: source.settingsView.effectiveProse,
    lastActivationOutcome: null,
    ...overrides
  };
}

describe("successor read-only Settings presentation", () => {
  test("successor read-only profile row names ownership and update path", () => {
    const { source } = settingsHarness();
    const view = readOnlyView(source, { readOnlyReason: "successor-schema" });
    const overlay = initialSettingsOverlay(view, source.config);

    expect(profileRowValue(overlay)).toBe("‹ successor-owned ›");
    expect(profileRowHint(overlay)).toBe(
      "newer settings are read-only · successor owns settings · update 1667"
    );
    expect(effortRowValue(overlay)).toBe("‹ unavailable ›");
    expect(effortRowHint(overlay)).toBe(
      "newer settings are read-only · successor owns settings · update 1667"
    );
    expect(settingsRows(overlay, source.config).find((row) => row.id === "cache-policy"))
      .toMatchObject({
        value: "‹ successor-owned ›",
        hint: "newer settings are read-only · successor owns settings · update 1667",
        dots: ""
      });
    expect(settingsRows(overlay, source.config).find((row) => row.id === "image-input"))
      .toMatchObject({
        value: "‹ successor-owned ›",
        hint: "newer settings are read-only · successor owns settings · update 1667"
      });
  });

  test("successor subscription protocols drive the fixed plan presentation", () => {
    const { source } = settingsHarness();
    for (const plan of [
      {
        protocol: "openai-codex-responses" as const,
        preset: "chatgpt-plan" as const,
        provider: "openai-compatible" as const,
        label: "ChatGPT plan",
        hint: "In a terminal, run 1667 auth login chatgpt to sign in. ChatGPT output length is best effort."
      },
      {
        protocol: "anthropic-subscription-messages" as const,
        preset: "claude-plan" as const,
        provider: "anthropic" as const,
        label: "Claude plan",
        hint: "In a terminal, run 1667 auth login claude to sign in. Claude plan support is experimental."
      }
    ]) {
      const effective = {
        ...source.settingsView.effective,
        provider: plan.provider,
        baseUrl: "",
        apiKeyEnv: null,
        protocol: plan.protocol
      };
      const view = readOnlyView(source, {
        readOnlyReason: "successor-schema",
        effective,
        effectiveProse: effective,
        subscriptionAuth: { chatgpt: "signed-out", claude: "signed-out" }
      });
      const overlay = initialSettingsOverlay(view, source.config);
      const rows = settingsRows(overlay, source.config);
      const row = (id: string) => rows.find((candidate) => candidate.id === id);

      expect(settingsSubscriptionPreset(overlay)).toBe(plan.preset);
      expect(row("provider")).toMatchObject({
        value: `‹ ${plan.label} ›`,
        hint: plan.hint
      });
      expect(rows.map((candidate) => candidate.id)).not.toContain("base-url");
      expect(rows.map((candidate) => candidate.id)).not.toContain("api-key");
      expect(row("text-prompt-format")?.disabled).toBe(true);
      expect(row("split-think-tags")?.disabled).toBe(true);
    }
  });

  test("legacy and direct views keep non-subscription presentation", () => {
    const { source } = settingsHarness();
    const editable = initialSettingsOverlay(source.settingsView, source.config);
    expect(settingsSubscriptionPreset(editable)).toBe(null);

    const overlay = initialSettingsOverlay(readOnlyView(source), source.config);
    expect(settingsSubscriptionPreset(overlay)).toBe(null);
    expect(settingsRows(overlay, source.config).map((row) => row.id)).toContain("base-url");
  });

  test("legacy read-only profile row wording stays unchanged", () => {
    const { source } = settingsHarness();
    const view = readOnlyView(source);
    const overlay = initialSettingsOverlay(view, source.config);

    expect(profileRowValue(overlay)).toBe("‹ legacy profile ›");
    expect(profileRowHint(overlay)).toBe("Legacy settings are read-only.");
    expect(effortRowValue(overlay)).toBe("‹ default ›");
    expect(effortRowHint(overlay)).toBe(
      "Sets how much reasoning the model does before writing."
    );
    expect(settingsRows(overlay, source.config).find((row) => row.id === "cache-policy"))
      .toMatchObject({
        value: "‹ off ›",
        hint: "Prompt caching is unavailable in legacy settings."
      });
    expect(settingsRows(overlay, source.config).find((row) => row.id === "image-input"))
      .toMatchObject({
        value: "‹ - ›",
        hint: "Shows whether this model accepts image attachments."
      });
  });

  test("successor rows use closed response fields and name the rest as owned", () => {
    const { source } = settingsHarness();
    const effective = {
      ...source.settingsView.effective,
      provider: "text-completion" as const,
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "text-model",
      allowInsecureHttp: true as const
    };
    const successor = readOnlyView(source, {
      readOnlyReason: "successor-schema",
      effective,
      effectiveProse: effective,
      effectiveProseReasoning: "open",
      effectiveProseContinuationPromptLayout: "late-cache-stable"
    });
    const rows = settingsRows(initialSettingsOverlay(successor, source.config), source.config);
    const row = (id: string) => rows.find((candidate) => candidate.id === id);
    const remediation = "newer settings are read-only · successor owns settings · update 1667";

    expect(row("sampling")).toMatchObject({ value: "‹ successor-owned ›", hint: remediation });
    expect(row("reasoning")).toMatchObject({ value: "‹ open ›", dots: "", hint: remediation });
    expect(row("keep-thoughts")).toMatchObject({ value: "‹ successor-owned ›", hint: remediation });
    expect(row("continuation-prompt")).toMatchObject({ value: "[ on ]", hint: remediation });
    expect(row("text-prompt-format")).toMatchObject({ value: "‹ successor-owned ›", hint: remediation });
    expect(row("split-think-tags")).toMatchObject({ value: "‹ successor-owned ›", hint: remediation });
    expect(row("allow-insecure-http")).toMatchObject({ value: "[ on ]" });
    expect(row("api-key")).toMatchObject({ value: "‹ successor-owned ›", hint: remediation });
    expect(row("image-input")).toMatchObject({ value: "‹ successor-owned ›", hint: remediation });

    const missingFields = readOnlyView(source, {
      ...successor,
      effectiveProseReasoning: undefined,
      effectiveProseContinuationPromptLayout: undefined
    });
    const missingRows = settingsRows(
      initialSettingsOverlay(missingFields, source.config),
      source.config
    );
    expect(missingRows.find((candidate) => candidate.id === "reasoning")?.value)
      .toBe("‹ successor-owned ›");
    expect(missingRows.find((candidate) => candidate.id === "continuation-prompt")?.value)
      .toBe("‹ successor-owned ›");

    const legacy = readOnlyView(source, {
      ...missingFields,
      readOnlyReason: "legacy-migration"
    });
    const legacyRows = settingsRows(
      initialSettingsOverlay(legacy, source.config),
      source.config
    );
    const legacyRow = (id: string) => legacyRows.find((candidate) => candidate.id === id);
    expect(legacyRow("sampling")?.value).toBe("default · [disabled · read-only]");
    expect(legacyRow("reasoning")).toMatchObject({
      value: "‹ marker ›",
      hint: "Controls whether model reasoning is hidden, marked, or shown."
    });
    expect(legacyRow("keep-thoughts")).toMatchObject({
      value: "[ on ]",
      hint: "Saves model reasoning with each take."
    });
    expect(legacyRow("continuation-prompt")).toMatchObject({
      value: "[ off ]",
      hint: "Uses the established Continue and Retake layout; the alternative is experimental."
    });
    expect(legacyRow("text-prompt-format")).toMatchObject({
      value: "‹ raw ›",
      hint: "Sets how prompts are formatted for text-completion models."
    });
    expect(legacyRow("split-think-tags")).toMatchObject({
      value: "[ off ]",
      hint: "Keeps <think> text separate from story prose."
    });
  });
});
