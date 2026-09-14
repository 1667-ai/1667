import { createRendererApi } from "../../renderer-runtime.js";
import type { StoryApi } from "../../../client/api.js";

declare global {
  interface Window {
    ownershipApi: StoryApi;
    ownershipReady: boolean;
    ownershipError?: string;
  }
}

window.desktop?.shell?.onEvent(() => undefined);
void createRendererApi().then((api) => {
  window.ownershipApi = api;
  window.ownershipReady = true;
}).catch((error: unknown) => {
  window.ownershipError = error instanceof Error ? error.message : String(error);
});
