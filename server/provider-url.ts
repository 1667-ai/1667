import type { GenerationSettings } from "../shared/types.js";

/** Join a provider API path without duplicating an existing Anthropic v1. */
export function providerUrl(settings: GenerationSettings, pathName: string): string {
  const base = settings.baseUrl.replace(/\/+$/, "");
  let path = pathName.replace(/^\/+/, "");
  if (settings.provider === "anthropic" && base.endsWith("/v1") && path.startsWith("v1/")) {
    path = path.slice(3);
  }
  return `${base}/${path}`;
}

/** Get the server root for native routes that are outside v1. */
export function providerRoot(settings: GenerationSettings): string {
  return settings.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}
