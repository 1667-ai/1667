import { describe, expect, test } from "bun:test";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import type { SettingsView } from "../../shared/settings-v2-types.js";
import { setComposerText } from "../src/composer-model.js";

type ClipboardReader = () => Promise<string | null>;

const bunTest = await import("bun:test") as unknown as {
  mock: {
    module(path: string, factory: () => Record<string, unknown>): void;
  };
};
let clipboardReader: ClipboardReader = async () => null;
bunTest.mock.module("../src/clipboard.js", () => ({
  readFromClipboard: () => clipboardReader(),
  copyToClipboard: async () => "internal"
}));

const {
  deferred,
  key,
  openSettings,
  selectRow,
  settingsHarness
} = await import("./settings-test-harness.js");

describe("nested Sampling clipboard ownership", () => {
  test("ignores a late read after every owner-changing action and applies a current paste", async () => {
    const staleCases: readonly {
      name: string;
      change: (
        state: ReturnType<typeof settingsHarness>["state"],
        press: ReturnType<typeof settingsHarness>["press"]
      ) => Promise<void>;
      assertStale: (state: ReturnType<typeof settingsHarness>["state"]) => void;
    }[] = [
      {
        name: "typing",
        change: async (_state, press) => { await press(key("x")); },
        assertStale: (state) => {
          expect(state.settings?.sampling?.edit?.composer.text).toBe("x");
        }
      },
      {
        name: "cursor movement",
        change: async (_state, press) => { await press(key("left")); },
        assertStale: (state) => {
          expect(state.settings?.sampling?.edit?.composer.text).toBe("seed");
          expect(state.settings?.sampling?.edit?.composer.cursor).toBe(3);
        }
      },
      {
        name: "edit replacement",
        change: async (_state, press) => {
          await press(key("escape"));
          await press(key("return"));
        },
        assertStale: (state) => {
          expect(state.settings?.sampling?.edit?.composer.text).toBe("");
        }
      },
      {
        name: "nested close",
        change: async (_state, press) => {
          await press(key("escape"));
          await press(key("escape"));
        },
        assertStale: (state) => {
          expect(state.settings?.sampling).toBe(null);
          expect(state.toast).toBe("sampling closed · draft kept");
        }
      },
      {
        name: "Settings replacement",
        change: async (_state, press) => {
          await press(key("escape"));
          await press(key("escape"));
          await press(key("escape"));
        },
        assertStale: (state) => {
          expect(state.settings).toBe(null);
          expect(state.mode).toBe("NAV");
          expect(state.toast).toBe(null);
        }
      }
    ];

    for (const staleCase of staleCases) {
      const { state, press } = await openSamplingEdit();
      if (staleCase.name === "cursor movement") {
        const edit = state.settings?.sampling?.edit;
        if (edit === null || edit === undefined) throw new Error("Sampling edit did not open");
        setComposerText(edit.composer, "seed");
      }
      const read = deferred<string | null>();
      const started = deferred<void>();
      clipboardReader = async () => {
        started.resolve();
        return read.promise;
      };
      const paste = press(key("v", { ctrl: true }));
      await started.promise;
      await staleCase.change(state, press);
      read.resolve("late clipboard text");
      await paste;
      staleCase.assertStale(state);
      expect(state.toast === null || !state.toast.includes("clipboard")).toBeTrue();
    }

    const { state, press } = await openSamplingEdit();
    if (state.settings === null) throw new Error("Settings did not open");
    state.settings.conflict = { message: "Settings changed", armed: true };
    clipboardReader = async () => "0.7";
    await press(key("v", { ctrl: true }));

    expect(state.settings.sampling?.edit?.composer.text).toBe("0.7");
    expect(state.settings.conflict.armed).toBeFalse();
    expect(state.toast).toBe(null);
  });
});

async function openSamplingEdit() {
  const harness = settingsHarness();
  useSupportedSettings(harness.source);
  await openSettings(harness.press);
  await selectRow(harness.press, harness.state, "sampling");
  await harness.press(key("return"));
  await harness.press(key("return"));
  if (harness.state.settings?.sampling?.edit === null
    || harness.state.settings?.sampling?.edit === undefined) {
    throw new Error("Sampling edit did not open");
  }
  return harness;
}

function useSupportedSettings(source: ReturnType<typeof settingsHarness>["source"]): void {
  const active = source.settingsView;
  if (!active.editable) throw new Error("demo settings must be editable");
  const generation = {
    ...source.settings,
    provider: "openai-compatible" as const,
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "gpt-5.2",
    apiKeyEnv: null
  };
  const document = applyBasicSettingsDraft(active.document, generation);
  source.settingsView = {
    ...active,
    document,
    effective: basicSettingsFromDocument(document)
  } satisfies SettingsView;
  source.api.getSettings = async () => source.settingsView;
}
