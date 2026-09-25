/**
 * Package facts for the `web/` bundle.
 *
 * `web/` only ever imports `react` and `react-dom` from `node_modules` (see
 * `test/frontend-import-boundary.test.ts`'s "web/ imports only client/ and
 * shared/, and bare packages" rule) — `scheduler` reaches the bundle only as
 * `react-dom`'s own dependency. `cli/scripts/build-standalone.ts` asserts
 * this set equals the node_modules package names Vite's own Rollup output
 * reports (`cli/scripts/web-build.ts`'s `bundledPackageNames`) for the
 * running build: the web analogue of verifying with a Bun metafile, which
 * cannot see into a bundle that enters the compiled executable as a define
 * string.
 */
export const WEB_BUNDLED_PACKAGE_NAMES = Object.freeze([
  "react",
  "react-dom",
  "scheduler"
] as const);
