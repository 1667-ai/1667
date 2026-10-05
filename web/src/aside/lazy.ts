import { lazyView } from "../ui/LazyView.js";

// The choice of a place for an Aside answer loads when a writer starts it.
export const PlacementBanner = lazyView(() => import("./PlacementBar.js"), "PlacementBanner", { floating: true });
export const PlacementGap = lazyView(() => import("./PlacementBar.js"), "PlacementGap", { floating: true });
