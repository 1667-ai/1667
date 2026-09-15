import path from "node:path";
import { createRequire } from "node:module";
import { signAsync } from "@electron/osx-sign";

const require = createRequire(import.meta.url);
const entitlements = require.resolve("app-builder-lib/templates/entitlements.mac.plist");

export async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const application = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  await signAsync({
    app: application,
    platform: "darwin",
    identity: "-",
    identityValidation: false,
    optionsForFile: () => ({ entitlements, hardenedRuntime: true }),
    hardenedRuntime: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    timestamp: "none"
  });
}
