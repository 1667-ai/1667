import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Playwright is supplied by the desktop release workspace.
// @ts-ignore The root backend workspace does not install the desktop lane.
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { closeDesktopApp, goToLibrary, openSettingsSection } from "./electron-test-helpers.js";

const appPath = process.env.AI_1667_DESKTOP_APP_PATH;

test("Electron shell: grid geometry, breadcrumb truncation, themes, shortcuts, attention, focus", { timeout: 180_000 }, async () => {
  if (appPath === undefined || appPath.length === 0) {
    throw new Error("AI_1667_DESKTOP_APP_PATH must point to the built Electron main entry.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-desktop-shell-e2e-"));
  const dataDir = path.join(directory, "project");
  await mkdir(dataDir, { mode: 0o700 });
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(directory, "browser")}`, appPath],
    env: {
      ...process.env,
      AI_1667_STATE: path.join(directory, "machine"),
      AI_1667_DESKTOP_DATA_DIR: dataDir,
      AI_1667_NO_UPDATE_CHECK: "1"
    }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".new-story-button", { timeout: 30_000 });
    await createStory(page, "Shell geometry story");
    await page.locator(".composer-input").fill("The first part of the shell geometry story.");
    await page.locator(".composer-manual").click();
    await page.waitForSelector(".manuscript-part", { timeout: 15_000 });

    await test1440Geometry(app, page);
    await test960Geometry(app, page);
    await testBreadcrumbTruncation(app, page);
    await testThemeSwitch(page);
    await testShortcuts(page);
    await testSettingsAttention(page);
    await testFocusedPart(page);
  } finally {
    await closeDesktopApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

async function createStory(page: Page, title: string): Promise<void> {
  await goToLibrary(page);
  await page.locator(".new-story-button").click();
  await page.waitForSelector(".modal-card", { timeout: 15_000 });
  await page.locator(".modal-input").fill(title);
  await page.locator(".modal-submit").click();
  await page.waitForFunction((expected) => document.querySelector(".story-title")?.textContent === expected, title, { timeout: 15_000 });
}

// 1. At 1440x900 the titlebar is 44px tall, the rail 56px wide, the inspector
// 320px wide.
async function test1440Geometry(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  await page.waitForTimeout(150);
  for (const selector of [".titlebar", ".rail", ".inspector"]) {
    await page.locator(selector).waitFor({ state: "visible", timeout: 15_000 });
  }
  const titlebar = await page.locator(".titlebar").boundingBox();
  const rail = await page.locator(".rail").boundingBox();
  const inspector = await page.locator(".inspector").boundingBox();
  assert.ok(titlebar, "titlebar must render at 1440x900");
  assert.equal(Math.round(titlebar!.height), 44, "titlebar must be 44px tall");
  assert.ok(rail, "rail must render at 1440x900");
  assert.equal(Math.round(rail!.width), 56, "rail must be 56px wide");
  assert.ok(inspector, "inspector must render at 1440x900");
  assert.equal(Math.round(inspector!.width), 320, "inspector must be 320px wide at 1440");
}

// 2. At 960x640 the inspector docks below the main column, nothing
// horizontal-scrolls, and the prose column stays >= 600px wide.
async function test960Geometry(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
  await page.waitForTimeout(150);
  const workspace = await page.locator(".workspace").boundingBox();
  const inspector = await page.locator(".inspector").boundingBox();
  assert.ok(workspace && inspector, "workspace and inspector must render at 960x640");
  assert.ok(inspector!.y >= workspace!.y + workspace!.height - 1, "the inspector must dock below the main column at 960px");
  assert.ok(workspace!.width >= 600, `the prose column must stay >= 600px wide at 960px (was ${workspace!.width})`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.ok(!overflow, "nothing must horizontal-scroll at 960px");
  // On Windows the 960px window minimum includes the frame, so the page is
  // narrower than 960px. It must still fit without a horizontal scrollbar.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setMinimumSize(900, 600);
    window?.setContentSize(944, 640);
  });
  await page.waitForFunction(() => document.documentElement.clientWidth <= 944, undefined, { timeout: 5_000 });
  const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.ok(!narrowOverflow, "nothing must horizontal-scroll when the page is narrower than the 960px window");
  // Between 961 and 1180px the inspector still sits beside the manuscript, so
  // the manuscript must shrink to its column instead of spilling under the rail.
  for (const width of [1024, 1180, 1264]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size, 700), width);
    await page.waitForFunction((size) => document.documentElement.clientWidth === size, width, { timeout: 5_000 });
    const fit = await page.evaluate(() => {
      const workspace = document.querySelector(".workspace")!.getBoundingClientRect();
      const manuscript = document.querySelector(".manuscript")!;
      const box = manuscript.getBoundingClientRect();
      return { inside: box.left >= workspace.left && box.right <= workspace.right, tracksFit: manuscript.scrollWidth <= manuscript.clientWidth + 1 };
    });
    assert.ok(fit.inside && fit.tracksFit, `the manuscript must fit its column at ${width}px`);
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setMinimumSize(960, 640));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  await page.waitForTimeout(150);
}

// 3. A 200-character story title still shows the full ¶ n of n / take j of k
// segments; only the title segment truncates.
async function testBreadcrumbTruncation(app: ElectronApplication, page: Page): Promise<void> {
  const longTitle = "A story title that keeps going and going ".repeat(5).slice(0, 200);
  await goToLibrary(page);
  await page.locator(".rename-story").click();
  await page.waitForSelector(".modal-card", { timeout: 15_000 });
  await page.locator(".modal-input").fill(longTitle);
  await page.locator(".modal-submit").click();
  await page.waitForFunction(
    (expected) => document.querySelector(".story-title")?.textContent === expected,
    longTitle,
    { timeout: 15_000 }
  );
  await page.locator(".tab-write").click();
  await page.waitForSelector(".composer-input", { timeout: 15_000 });
  const info = await page.evaluate(() => {
    const title = document.querySelector<HTMLElement>(".story-title");
    const segments = [...document.querySelectorAll<HTMLElement>(".breadcrumb-segment")].map((el) => el.textContent ?? "");
    return {
      truncated: title !== null && title.scrollWidth > title.clientWidth,
      segments
    };
  });
  assert.ok(info.truncated, "a 200-character story title must truncate visually");
  assert.ok(info.segments.some((segment) => /¶ 1 of 1/u.test(segment)), `breadcrumb must still show '¶ 1 of 1' (segments: ${info.segments.join(" | ")})`);
  assert.ok(info.segments.some((segment) => /take 1 of 1/u.test(segment)), `breadcrumb must still show 'take 1 of 1' (segments: ${info.segments.join(" | ")})`);
  await goToLibrary(page);
  await page.locator(".rename-story").click();
  await page.waitForSelector(".modal-card", { timeout: 15_000 });
  await page.locator(".modal-input").fill("Shell geometry story");
  await page.locator(".modal-submit").click();
  await page.waitForFunction(
    () => document.querySelector(".story-title")?.textContent === "Shell geometry story",
    undefined,
    { timeout: 15_000 }
  );
  await page.locator(".tab-write").click();
  await page.waitForSelector(".composer-input", { timeout: 15_000 });
}

// 4. Selecting hi-contrast light changes the part's computed font to Georgia
// at 19px without a reload; selecting graphite restores the Literata stack.
async function testThemeSwitch(page: Page): Promise<void> {
  await page.locator(".tab-settings").click();
  await page.waitForSelector(".settings-editor", { timeout: 15_000 });
  await openSettingsSection(page, "desktop");
  await page.locator('.theme-swatch[data-theme="hi-contrast light"]').click();
  await page.locator(".tab-write").click();
  await page.waitForSelector(".part-prose", { timeout: 15_000 });
  const hiContrast = await page.evaluate(() => {
    const part = document.querySelector<HTMLElement>(".part-prose");
    if (part === null) return null;
    const style = getComputedStyle(part);
    return { fontFamily: style.fontFamily, fontSize: style.fontSize };
  });
  assert.ok(hiContrast !== null, "the part prose must be present to measure its font");
  assert.match(hiContrast!.fontFamily, /Georgia/u);
  assert.equal(hiContrast!.fontSize, "19px");

  await page.locator(".tab-settings").click();
  await page.waitForSelector(".settings-editor", { timeout: 15_000 });
  await openSettingsSection(page, "desktop");
  await page.locator('.theme-swatch[data-theme="graphite"]').click();
  await page.locator(".tab-write").click();
  await page.waitForSelector(".part-prose", { timeout: 15_000 });
  const graphite = await page.evaluate(() => {
    const part = document.querySelector<HTMLElement>(".part-prose");
    return part === null ? null : getComputedStyle(part).fontFamily;
  });
  assert.ok(graphite !== null);
  assert.match(graphite!, /Literata/u);
}

// 5. Cmd/Ctrl+3 shows Facts, Cmd/Ctrl+, shows Settings, Cmd/Ctrl+1 shows the
// Library with its story rows.
async function testShortcuts(page: Page): Promise<void> {
  const shortcut = process.platform === "darwin" ? "Meta" : "Control";
  await page.locator(".tab-write").click();
  await page.waitForSelector(".composer-input", { timeout: 15_000 });
  await page.keyboard.press(`${shortcut}+3`);
  await page.waitForSelector(".tab-content.facts", { timeout: 15_000 });
  await page.keyboard.press(`${shortcut}+,`);
  await page.waitForSelector(".tab-content.settings", { timeout: 15_000 });
  await page.keyboard.press(`${shortcut}+1`);
  await page.waitForSelector(".tab-content.library", { timeout: 15_000 });
  await page.waitForSelector(".story-row", { timeout: 15_000 });
  await page.locator(".tab-write").click();
  await page.waitForSelector(".composer-input", { timeout: 15_000 });
}

// 6. A pending settings revision lights the rail's Settings attention dot.
async function testSettingsAttention(page: Page): Promise<void> {
  await page.locator(".tab-settings").click();
  await page.waitForSelector(".settings-editor", { timeout: 15_000 });
  await openSettingsSection(page, "profiles");
  await page.click(".settings-connection-create");
  const profileName = await page.locator(".settings-profile-select.active strong").innerText();
  await openSettingsSection(page, "connections");
  await page.fill(".settings-control-connection-name", "Unreachable provider");
  await page.selectOption(".settings-control-connection-preset", "custom");
  await page.selectOption(".settings-control-connection-protocol", "openai-chat-completions");
  await page.fill(".settings-control-connection-baseUrl", "https://example.test/v1");
  await page.selectOption(".settings-control-connection-authType", "bearer-stored");
  await page.locator("input[data-preserve^='settings:secret:']").fill("placeholder-secret");
  await openSettingsSection(page, "routes");
  await page.selectOption(".settings-control-route-prose", { label: profileName });
  await openSettingsSection(page, "output");
  await page.fill('[data-settings-field="profile.maxOutputTokens"]', "999");
  await page.click(".settings-save");
  await page.waitForFunction(
    () => document.querySelector(".settings-discard-pending") !== null
      || Boolean(document.querySelector(".settings-global-error")?.textContent),
    undefined,
    { timeout: 30_000 }
  );
  assert.equal(await page.locator(".settings-discard-pending").count(), 1, "an unreachable provider must leave a pending revision");
  await page.waitForSelector(".tab-settings .attention", { timeout: 15_000 });
  await page.click(".settings-discard-pending");
  await page.waitForFunction(() => document.querySelector(".settings-discard-pending") === null, undefined, { timeout: 15_000 });
}

// 7. Clicking a part sets .manuscript-part.focused on it and the inspector
// eyebrow reads "Takes at ¶ <n>".
async function testFocusedPart(page: Page): Promise<void> {
  await page.locator(".tab-write").click();
  await page.waitForSelector(".composer-input", { timeout: 15_000 });
  await page.locator(".composer-input").fill("A second part for the focus proof.");
  await page.locator(".composer-manual").click();
  await page.waitForFunction(() => document.querySelectorAll(".manuscript-part").length === 2, undefined, { timeout: 15_000 });
  const firstPart = page.locator(".manuscript-part").first();
  await firstPart.locator(".part-prose").click();
  await page.waitForFunction(() => document.querySelector(".manuscript-part.focused") !== null, undefined, { timeout: 15_000 });
  assert.equal(await page.locator(".manuscript-part").first().evaluate((el) => el.classList.contains("focused")), true);
  const eyebrow = page.locator(".inspector-section-header").first();
  await page.waitForFunction(
    () => /takes at ¶ 1/iu.test(document.querySelector(".inspector-section-header")?.textContent ?? ""),
    undefined,
    { timeout: 15_000 }
  );
  assert.match(await eyebrow.innerText(), /takes at ¶ 1/iu);
}
