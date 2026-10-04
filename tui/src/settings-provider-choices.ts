import { ownedLoopbackHttpSupportedOn } from "../../shared/provider-transport-capability.js";

export * from "../../shared/settings-provider-choices.js";

/** The terminal's own platform decides this. The web asks the server instead. */
export function localProviderPresetsSupported(): boolean {
  return ownedLoopbackHttpSupportedOn(
    process.platform,
    typeof process.getuid === "function"
  );
}
