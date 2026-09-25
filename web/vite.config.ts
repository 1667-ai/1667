import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const DEV_HOST = "127.0.0.1";
const DEV_PORT = 5173;
const DEV_ORIGIN = `http://${DEV_HOST}:${DEV_PORT}`;

interface OutgoingProxyRequest {
  setHeader(name: string, value: string): void;
}

/**
 * `host/web-server.ts` refuses any `Origin` that is not its own loopback
 * port — a foreign origin stays refused, on purpose. In dev, the browser's
 * real origin is this Vite server (`DEV_ORIGIN`), not the backend it proxies
 * to, so a proxied request would be refused unless its `Origin` header is
 * rewritten to the backend's own origin first. `changeOrigin` (below)
 * already rewrites `Host`; it never touches `Origin`, so this is the other
 * half. Only the exact dev origin is rewritten — anything else (a browser
 * extension, a stray tab on another port) reaches the backend unchanged and
 * is refused there, exactly as it would be without this proxy.
 */
function rewriteDevOrigin(
  proxyReq: OutgoingProxyRequest,
  req: IncomingMessage,
  targetOrigin: string
): void {
  if (req.headers.origin === DEV_ORIGIN) {
    proxyReq.setHeader("origin", targetOrigin);
  }
}

export default defineConfig({
  root: here,
  plugins: [react()],
  envDir: false,
  server: {
    host: DEV_HOST,
    port: DEV_PORT,
    strictPort: true,
    fs: {
      // Replaces Vite's default allow list (the project root only): the dev
      // server also serves `client/` and `shared/` sources directly, and
      // needs the workspace's single `node_modules` at the repository root.
      allow: [
        here,
        path.join(repoRoot, "client"),
        path.join(repoRoot, "shared"),
        path.join(repoRoot, "node_modules")
      ]
    },
    proxy: {
      "/api": {
        target: process.env.AI_1667_WEB_DEV_TARGET,
        ws: true,
        changeOrigin: true,
        configure(proxy) {
          const target = process.env.AI_1667_WEB_DEV_TARGET;
          if (target === undefined) return;
          const targetOrigin = new URL(target).origin;
          proxy.on("proxyReq", (proxyReq, req) => rewriteDevOrigin(proxyReq, req, targetOrigin));
          proxy.on("proxyReqWs", (proxyReq, req) => rewriteDevOrigin(proxyReq, req, targetOrigin));
        }
      }
    }
  },
  build: {
    // No `data:` URLs: every asset (including a woff2 font) is its own
    // hashed file, so `cli/scripts/web-build.ts` can map it to its own
    // `/assets/...` route with its own content type.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false }
  }
});
