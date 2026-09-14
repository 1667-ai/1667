#!/usr/bin/env -S node --import tsx

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

interface Options {
  readonly oldAppImage: string;
  readonly newAppImage: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly channel: "stable" | "beta";
}

interface BrowserWindowApi {
  readonly testApi?: {
    createStory(title: string): Promise<{ readonly id: string; readonly title: string }>;
    createNode(storyId: string, request: { parentId: string | null; text: string }): Promise<StoryPayload>;
    listStories(): Promise<readonly StorySummary[]>;
    loadStory(storyId: string): Promise<StoryPayload>;
  };
  readonly testError?: string;
  readonly testReady?: boolean;
}

interface StorySummary {
  readonly id: string;
  readonly title: string;
}

interface StoryPayload {
  readonly id: string;
  readonly title: string;
  readonly path: readonly { readonly text: string }[];
}

declare global {
  interface Window extends BrowserWindowApi {}
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Run the installed Linux AppImage update proof against a throwaway feed. */
export async function runAppImageUpdateProof(options: Options): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("The installed AppImage proof requires Linux.");
  }
  const oldAppImage = path.resolve(options.oldAppImage);
  const newAppImage = path.resolve(options.newAppImage);
  await assertRegularFile(oldAppImage, "old AppImage");
  await assertRegularFile(newAppImage, "new AppImage");

  const root = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-appimage-update-"));
  const project = path.join(root, "project");
  const machine = path.join(root, "machine");
  const home = path.join(root, "home");
  const temp = path.join(root, "tmp");
  const oldBrowser = path.join(root, "browser-old");
  const newBrowser = path.join(root, "browser-new");
  const currentAppImage = path.join(root, path.basename(oldAppImage));
  const installedAppImage = path.join(root, path.basename(newAppImage));
  let app: ElectronApplication | null = null;
  let updatedApp: ElectronApplication | null = null;
  const server = createServer();

  try {
    await mkdir(project, { recursive: true });
    await mkdir(machine, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(temp, { recursive: true });
    await copyFile(oldAppImage, currentAppImage);
    await chmod(currentAppImage, 0o755);
    const fixture = await createFixture(root);
    const artifact = await readFile(newAppImage);
    const digest = createHash("sha512").update(artifact).digest("base64");
    const metadata = updateMetadata(options, path.basename(newAppImage), digest, artifact.length);
    const feedPath = `${channelName(options.channel)}${linuxSuffix()}.yml`;
    const feedUrl = await serveFeed(server, feedPath, metadata, path.basename(newAppImage), newAppImage);
    const environment: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
      APPIMAGE_EXTRACT_AND_RUN: "1",
      AI_1667_STATE: machine,
      AI_1667_DESKTOP_DATA_DIR: project,
      AI_1667_DESKTOP_RENDERER_URL: fixture.rendererUrl,
      AI_1667_NO_UPDATE_CHECK: "1",
      ELECTRON_DISABLE_SANDBOX: "1",
      HOME: home,
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      TMPDIR: temp,
      APPIMAGE: currentAppImage
    };

    app = await launchAppImage(currentAppImage, oldBrowser, environment);
    const before = await app.evaluate(({ app: electronApp }) => ({
      version: electronApp.getVersion(),
      packaged: electronApp.isPackaged,
      appImage: process.env.APPIMAGE
    }));
    assert.deepEqual(before, {
      version: options.fromVersion,
      packaged: true,
      appImage: currentAppImage
    });
    const page = await app.firstWindow();
    await waitForFixture(page);
    const story = await page.evaluate(async () => {
      const created = await window.testApi!.createStory("Installed update persistence");
      return await window.testApi!.createNode(created.id, {
        parentId: null,
        text: "Saved before the installed update."
      });
    });
    assert.equal(story.title, "Installed update persistence");

    const update = await app.evaluate(async ({ app: electronApp }, input) => {
      const nodePath = process.getBuiltinModule("path") as typeof import("node:path");
      const nodeModule = process.getBuiltinModule("module") as typeof import("node:module");
      const require = nodeModule.createRequire(
        nodePath.join(process.resourcesPath, "app.asar", "package.json")
      );
      const module = require("electron-updater") as {
        autoUpdater?: ElectronUpdaterLike;
        default?: { autoUpdater?: ElectronUpdaterLike };
      };
      const updater = module.autoUpdater ?? module.default?.autoUpdater;
      if (updater === undefined) throw new Error("electron-updater singleton is unavailable");
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.disableDifferentialDownload = true;
      updater.setFeedURL({ provider: "generic", url: input.url });
      updater.channel = input.channel;
      updater.allowPrerelease = input.channel === "beta";
      const checked = await updater.checkForUpdates();
      if (checked === null || checked.updateInfo.version !== input.expectedVersion) {
        throw new Error(`Unexpected update metadata: ${JSON.stringify(checked)}`);
      }
      const downloaded = await updater.downloadUpdate();
      if (downloaded.length !== 1) throw new Error(`Unexpected downloaded files: ${JSON.stringify(downloaded)}`);
      return {
        checked: checked.updateInfo.version,
        downloaded,
        installed: updater.install(false, true),
        appVersion: electronApp.getVersion()
      };
    }, { url: feedUrl, expectedVersion: options.toVersion, channel: channelName(options.channel) });
    assert.equal(update.checked, options.toVersion);
    assert.equal(update.installed, true);
    await stopApplication(app, [oldBrowser, home, currentAppImage, installedAppImage]);
    app = null;

    await waitForInstalled(currentAppImage, installedAppImage);
    killMatching(home);
    killMatching(installedAppImage);
    await new Promise((resolve) => setTimeout(resolve, 500));
    updatedApp = await launchAppImage(installedAppImage, newBrowser, {
      ...environment,
      APPIMAGE: installedAppImage
    });
    const after = await updatedApp.evaluate(({ app: electronApp }) => ({
      version: electronApp.getVersion(),
      packaged: electronApp.isPackaged,
      appImage: process.env.APPIMAGE
    }));
    assert.deepEqual(after, {
      version: options.toVersion,
      packaged: true,
      appImage: installedAppImage
    });
    const updatedPage = await updatedApp.firstWindow();
    await waitForFixture(updatedPage);
    const persisted = await updatedPage.evaluate(async () => {
      const summary = (await window.testApi!.listStories()).find(
        (candidate) => candidate.title === "Installed update persistence"
      );
      if (summary === undefined) throw new Error("Saved story is missing after update");
      const story = await window.testApi!.loadStory(summary.id);
      return { id: story.id, title: story.title, text: story.path[0]?.text };
    });
    assert.equal(persisted.title, "Installed update persistence");
    assert.equal(persisted.text, "Saved before the installed update.");
    console.log(JSON.stringify({ before, update, after, persisted, feedPath }));
  } finally {
    if (app !== null) await stopApplication(app, [oldBrowser, home, currentAppImage, installedAppImage]);
    if (updatedApp !== null) await stopApplication(updatedApp, [newBrowser, home, installedAppImage]);
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}

interface ElectronUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableDifferentialDownload: boolean;
  allowPrerelease: boolean;
  channel: string;
  setFeedURL(options: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<{ readonly updateInfo: { readonly version: string } } | null>;
  downloadUpdate(): Promise<readonly string[]>;
  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean;
}

async function createFixture(root: string): Promise<{ readonly rendererUrl: string }> {
  const source = path.join(root, "fixture.ts");
  const script = path.join(root, "fixture.js");
  const html = path.join(root, "fixture.html");
  await writeFile(source, `import { createRendererApi } from ${JSON.stringify(path.join(desktopRoot, "renderer-runtime.ts"))};
declare global { interface Window { testReady?: boolean; testApi?: Awaited<ReturnType<typeof createRendererApi>>; testError?: string; } }
void createRendererApi().then((api) => { window.testApi = api; window.testReady = true; }).catch((error) => { window.testError = error instanceof Error ? error.message : String(error); });
`);
  await build({ entryPoints: [source], outfile: script, bundle: true, platform: "browser", format: "esm" });
  await writeFile(html, `<!doctype html><meta charset="utf-8"><title>AppImage update proof</title><script type="module" src="${script}"></script>`);
  return { rendererUrl: pathToFileURL(html).href };
}

async function launchAppImage(
  appImage: string,
  browserDirectory: string,
  environment: Record<string, string>
): Promise<ElectronApplication> {
  return await electron.launch({
    executablePath: appImage,
    args: ["--no-sandbox", `--user-data-dir=${browserDirectory}`],
    env: environment,
    timeout: 120_000
  });
}

async function waitForFixture(page: Page): Promise<void> {
  await page.waitForFunction(() => window.testReady || window.testError, undefined, { timeout: 30_000 });
  const error = await page.evaluate(() => window.testError);
  assert.equal(error, undefined);
}

function updateMetadata(
  options: Options,
  fileName: string,
  sha512: string,
  size: number
): string {
  return [
    `version: ${options.toVersion}`,
    "files:",
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ""
  ].join("\n");
}

async function serveFeed(
  server: ReturnType<typeof createServer>,
  feedPath: string,
  metadata: string,
  fileName: string,
  filePath: string
): Promise<string> {
  server.on("request", async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1);
    if (pathname === feedPath) {
      response.writeHead(200, { "content-type": "text/yaml" });
      response.end(metadata);
      return;
    }
    if (pathname === fileName) {
      try {
        const body = await readFile(filePath);
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(body.length)
        });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end("missing");
      }
      return;
    }
    response.writeHead(404);
    response.end("missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}/`;
}

async function stopApplication(app: ElectronApplication, cleanupPatterns: readonly string[]): Promise<void> {
  const process = app.process();
  try {
    await Promise.race([
      app.evaluate(({ app: electronApp }) => electronApp.exit(0)),
      new Promise((resolve) => setTimeout(resolve, 3_000))
    ]);
  } catch {
    // The app can exit before evaluate returns.
  }
  if (process.exitCode === null && !process.killed) process.kill("SIGKILL");
  if (process.exitCode === null) {
    await new Promise<void>((resolve) => process.once("exit", () => resolve()));
  }
  for (const pattern of cleanupPatterns) killMatching(pattern);
}

function killMatching(pattern: string): void {
  if (process.platform !== "linux") return;
  spawnSync("pkill", ["-KILL", "-f", pattern], { stdio: "ignore" });
}

async function waitForInstalled(oldAppImage: string, newAppImage: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const oldExists = await fileExists(oldAppImage);
    const newExists = await fileExists(newAppImage);
    if (!oldExists && newExists) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`AppImage install did not replace ${oldAppImage} with ${newAppImage}`);
}

async function assertRegularFile(file: string, label: string): Promise<void> {
  const details = await stat(file);
  if (!details.isFile()) throw new Error(`${label} is not a regular file: ${file}`);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function channelName(channel: Options["channel"]): string {
  return channel === "stable" ? "latest" : "beta";
}

function linuxSuffix(): string {
  return process.arch === "x64" ? "-linux" : `-linux-${process.arch}`;
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const current = argv[index]!;
    if (!current.startsWith("--")) throw new Error(`Unexpected argument: ${current}`);
    const equals = current.indexOf("=");
    const name = equals < 0 ? current : current.slice(0, equals);
    const value = equals < 0 ? argv[++index] : current.slice(equals + 1);
    if (value === undefined || value.length === 0) throw new Error(`${name} requires a value`);
    values.set(name, value);
  }
  const oldAppImage = values.get("--old");
  const newAppImage = values.get("--new");
  const fromVersion = values.get("--from-version");
  const toVersion = values.get("--to-version");
  const channel = values.get("--channel") ?? "beta";
  if (oldAppImage === undefined || newAppImage === undefined || fromVersion === undefined || toVersion === undefined) {
    throw new Error("usage: test-appimage-update.ts --old <AppImage> --new <AppImage> --from-version <version> --to-version <version> [--channel beta|stable]");
  }
  if (channel !== "stable" && channel !== "beta") throw new Error("--channel must be stable or beta");
  return { oldAppImage, newAppImage, fromVersion, toVersion, channel };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runAppImageUpdateProof(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
