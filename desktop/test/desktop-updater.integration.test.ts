import assert from "node:assert/strict";
import { createServer, request as httpRequest, type RequestOptions } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppUpdater, type DownloadUpdateOptions } from "electron-updater/out/AppUpdater.js";
import { ElectronUpdater } from "../updater.js";
import { FileUpdateChannelStore } from "../update-channel.js";

test("desktop updater uses real generic metadata, persistence, and busy guards", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-updater-feed-"));
  const store = new FileUpdateChannelStore(path.join(root, "machine", "desktop-update-channel.json"));
  const requests: string[] = [];
  const suffix = channelFileSuffix();
  const latestFile = `/latest${suffix}.yml`;
  const betaFile = `/beta${suffix}.yml`;
  const server = createServer((request, response) => {
    const resource = (request.url ?? "/").split("?", 1)[0] ?? "/";
    requests.push(resource);
    const body = resource === latestFile
      ? "version: 0.12.0\n"
      : resource === betaFile
        ? "version: 0.11.0-beta.2\n"
        : null;
    response.writeHead(body === null ? 404 : 200, { "content-type": "text/yaml" });
    response.end(body ?? "missing");
  });
  const portNumber = await listen(server);
  const feedUrl = `http://127.0.0.1:${portNumber}/`;
  try {
    assert.equal(await store.read(), "stable");
    const stableUpdater = new LocalFeedUpdater(testApp(root, "0.11.0"), feedUrl);
    const stable = new ElectronUpdater(stableUpdater, {
      platform: "linux",
      initialChannel: await store.read(),
      saveChannel: (channel) => store.write(channel)
    });
    stableUpdater.setFeedURL({ provider: "generic", url: feedUrl });

    const stableState = await stable.check();
    assert.equal(stableState.state, "available");
    assert.equal(stableState.version, "0.12.0");
    assert.equal(stableUpdater.channel, "latest");
    assert.equal(stableUpdater.allowDowngrade, false);
    assert.equal(stableUpdater.allowPrerelease, false);
    assert.deepEqual(requests, [latestFile]);

    assert.deepEqual(await stable.check(), stableState);
    assert.deepEqual(requests, [latestFile]);

    await assert.rejects(
      stable.setChannel("beta"),
      /Cannot change update channel while an update is available/
    );
    stableUpdater.emit("download-progress", {
      total: 100,
      delta: 50,
      transferred: 50,
      percent: 50,
      bytesPerSecond: 1
    });
    assert.equal((await stable.check()).state, "downloading");
    await assert.rejects(
      stable.setChannel("beta"),
      /Cannot change update channel while an update is downloading/
    );
    stableUpdater.emit("update-downloaded", {
      version: "0.12.0",
      files: [],
      path: "1667.zip",
      sha512: "test",
      releaseDate: new Date().toISOString(),
      downloadedFile: "update.zip"
    });
    assert.equal((await stable.check()).state, "downloaded");
    await assert.rejects(
      stable.setChannel("beta"),
      /Cannot change update channel while an update is downloaded/
    );
    assert.equal(stable.state.channel, "stable");

    let installAborted = false;
    let installApproved = false;
    const guardedUpdater = new LocalFeedUpdater(testApp(root, "0.11.0"), feedUrl);
    const guarded = new ElectronUpdater(guardedUpdater, {
      platform: "linux",
      beforeInstall: async () => installApproved,
      onInstallAborted: () => { installAborted = true; }
    });
    guardedUpdater.emit("update-downloaded", {
      version: "0.12.0",
      files: [],
      path: "1667.zip",
      sha512: "test",
      releaseDate: new Date().toISOString(),
      downloadedFile: "update.zip"
    });
    const cancelledInstall = await guarded.install();
    assert.equal(cancelledInstall.state, "downloaded");
    assert.match(cancelledInstall.message ?? "", /save or discard unsaved changes/iu);
    assert.equal(installAborted, true);
    assert.equal(guardedUpdater.installCalls, 0);
    installApproved = true;
    await guarded.install();
    assert.equal(guardedUpdater.installCalls, 1);
    guarded.dispose();

    stable.dispose();
    assert.equal(await store.read(), "stable");

    const betaUpdater = new LocalFeedUpdater(testApp(root, "0.11.0-beta.1"), feedUrl);
    const beta = new ElectronUpdater(betaUpdater, {
      platform: "linux",
      initialChannel: await store.read(),
      saveChannel: (channel) => store.write(channel)
    });
    betaUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    await beta.setChannel("beta");
    assert.equal(await store.read(), "beta");
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "machine", "desktop-update-channel.json"), "utf8")), {
      channel: "beta"
    });
    if (process.platform !== "win32") {
      assert.equal((await stat(path.join(root, "machine", "desktop-update-channel.json"))).mode & 0o777, 0o600);
    }
    const betaState = await beta.check();
    assert.equal(betaState.state, "available");
    assert.equal(betaState.version, "0.11.0-beta.2");
    assert.equal(betaUpdater.channel, "beta");
    assert.equal(betaUpdater.allowDowngrade, false);
    assert.equal(betaUpdater.allowPrerelease, true);
    assert.deepEqual(requests, [latestFile, betaFile]);
    beta.dispose();

    const reloadedUpdater = new LocalFeedUpdater(testApp(root, "0.11.0-beta.1"), feedUrl);
    const reloaded = new ElectronUpdater(reloadedUpdater, { platform: "linux", initialChannel: await store.read() });
    assert.equal(reloaded.state.channel, "beta");
    assert.equal(reloadedUpdater.channel, "beta");
    reloaded.dispose();
  } finally {
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop updater waits for delayed channel persistence before checking", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-updater-concurrency-"));
  const store = new FileUpdateChannelStore(path.join(root, "machine", "desktop-update-channel.json"));
  const requests: string[] = [];
  const suffix = channelFileSuffix();
  const betaFile = `/beta${suffix}.yml`;
  let releaseFeed!: () => void;
  let markRequestStarted!: () => void;
  const feedGate = new Promise<void>((resolve) => { releaseFeed = resolve; });
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
  const server = createServer((request, response) => {
    const resource = (request.url ?? "/").split("?", 1)[0] ?? "/";
    requests.push(resource);
    const body = resource === betaFile ? "version: 0.11.0-beta.2\n" : null;
    if (body === null) {
      response.writeHead(404, { "content-type": "text/yaml" });
      response.end("missing");
      return;
    }
    markRequestStarted();
    void feedGate.then(() => {
      response.writeHead(200, { "content-type": "text/yaml" });
      response.end(body);
    });
  });
  const portNumber = await listen(server);
  const feedUrl = `http://127.0.0.1:${portNumber}/`;
  let releaseSave!: () => void;
  let markSaveStarted!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
  try {
    const updater = new LocalFeedUpdater(testApp(root, "0.11.0-beta.1"), feedUrl);
    const port = new ElectronUpdater(updater, {
      platform: "linux",
      initialChannel: await store.read(),
      saveChannel: async (channel) => {
        markSaveStarted();
        await saveGate;
        await store.write(channel);
      }
    });
    updater.setFeedURL({ provider: "generic", url: feedUrl });

    const changing = port.setChannel("beta");
    await saveStarted;
    const checking = port.check();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(port.state.state, "idle");
    assert.deepEqual(requests, []);

    releaseSave();
    await changing;
    await requestStarted;
    assert.equal(port.state.state, "checking");
    assert.equal((await port.check()).state, "checking");
    assert.deepEqual(requests, [betaFile]);
    releaseFeed();
    const checked = await checking;
    assert.equal(checked.state, "available");
    assert.equal(checked.channel, "beta");
    assert.equal(await store.read(), "beta");
    assert.deepEqual(requests, [betaFile]);
    port.dispose();
  } finally {
    releaseFeed();
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop updater keeps Mac updates manual and opens the exact release tag", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-updater-mac-"));
  const requests: string[] = [];
  const suffix = channelFileSuffix();
  const latestFile = `/latest${suffix}.yml`;
  const betaFile = `/beta${suffix}.yml`;
  const server = createServer((request, response) => {
    const resource = (request.url ?? "/").split("?", 1)[0] ?? "/";
    requests.push(resource);
    const body = resource === latestFile
      ? "version: 0.12.0\n"
      : resource === betaFile
        ? "version: 0.12.0-beta.2\n"
        : null;
    response.writeHead(body === null ? 404 : 200, { "content-type": "text/yaml" });
    response.end(body ?? "missing");
  });
  const portNumber = await listen(server);
  const feedUrl = `http://127.0.0.1:${portNumber}/`;
  let openedUrl: string | undefined;
  try {
    const updater = new LocalFeedUpdater(testApp(root, "0.11.0"), feedUrl);
    const port = new ElectronUpdater(updater, {
      platform: "darwin",
      openExternal: async (url) => { openedUrl = url; }
    });
    updater.setFeedURL({ provider: "generic", url: feedUrl });

    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    const available = await port.check();
    assert.equal(available.manual, true);
    assert.equal(available.state, "available");
    assert.equal(available.version, "0.12.0");
    assert.deepEqual(requests, [latestFile]);
    assert.equal(updater.downloadCalls, 0);

    const channel = await port.setChannel("beta");
    assert.equal(channel.manual, true);
    assert.equal(channel.channel, "beta");
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    const beta = await port.check();
    assert.equal(beta.state, "available");
    assert.equal(beta.version, "0.12.0-beta.2");
    assert.deepEqual(requests, [latestFile, betaFile]);

    const opened = await port.install();
    assert.equal(opened.state, "available");
    assert.equal(opened.version, "0.12.0-beta.2");
    assert.equal(openedUrl, "https://github.com/1667-ai/1667/releases/tag/v0.12.0-beta.2");
    assert.equal(updater.downloadCalls, 0);
    assert.equal(updater.installCalls, 0);
    assert.match(opened.message ?? "", /save your work, quit 1667, then replace the app manually/iu);
    port.dispose();
  } finally {
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

class LocalFeedUpdater extends AppUpdater {
  public installCalls = 0;
  public downloadCalls = 0;

  constructor(app: ReturnType<typeof testApp>, private readonly feedUrl: string) {
    super(null, app);
    Reflect.set(this, "httpExecutor", new LocalHttpExecutor());
  }

  override setFeedURL(_options: Parameters<AppUpdater["setFeedURL"]>[0]): void {
    super.setFeedURL({ provider: "generic", url: this.feedUrl });
  }

  protected override async doDownloadUpdate(_options: DownloadUpdateOptions): Promise<string[]> {
    this.downloadCalls += 1;
    return [];
  }

  override quitAndInstall(): void { this.installCalls += 1; }
}

class LocalHttpExecutor {
  request(options: RequestOptions): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(options, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${response.statusCode ?? 500}`));
          } else {
            resolve(body.length === 0 ? null : body);
          }
        });
      });
      request.on("error", reject);
      request.end();
    });
  }
}

function testApp(root: string, version: string) {
  return {
    version,
    name: "1667",
    isPackaged: true,
    appUpdateConfigPath: path.join(root, "app-update.yml"),
    userDataPath: root,
    baseCachePath: root,
    whenReady: async () => {},
    relaunch: () => {},
    quit: () => {},
    onQuit: (_handler: (exitCode: number) => void) => {}
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Feed server did not expose a port");
  return (address as AddressInfo).port;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function channelFileSuffix(): string {
  if (process.platform === "darwin") return "-mac";
  if (process.platform !== "linux") return "";
  const arch = process.env.TEST_UPDATER_ARCH ?? process.arch;
  return `-linux${arch === "x64" ? "" : `-${arch}`}`;
}
