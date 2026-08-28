import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../server/project-discovery.js";
import { isSealed } from "../shared/vault-cipher.js";
import { stripInheritedAcl } from "./state-root-fixture.js";
import { runBunCli } from "./bun-cli-test-process.js";

const PASSPHRASE = "correct horse battery staple";

/**
 * The standalone executable holds the Bun runtime, so the vault commands must
 * seal and unseal under Bun and not only under Node.js. The two runtimes report
 * a successful `scrypt` derivation differently, and this test runs the product
 * through its command line to hold both runtimes to one result.
 */
test("E2E integration: the Bun runtime seals and unseals a project vault", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-vault-runtime-"));
  await stripInheritedAcl(root);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const project = await initializeProject(root);
  const storyFile = path.join(project.directory, "sentinel.json");
  const plaintext = "vault runtime sentinel: small green comet";
  await writeFile(storyFile, plaintext);

  const passphraseFile = path.join(root, "passphrase.txt");
  await writeFile(passphraseFile, `${PASSPHRASE}\n`);

  const entrypoint = path.resolve("tui/src/standalone.ts");
  const env = { ...process.env, AI_1667_STATE: path.join(root, "machine") };
  const vaultCommand = async (command: "encrypt" | "decrypt"): Promise<void> => {
    await runBunCli(
      [entrypoint, command, "--data", project.root, "--passphrase-file", passphraseFile],
      { env }
    );
  };

  await vaultCommand("encrypt");
  assert.ok(isSealed(await readFile(storyFile)), "encrypt must seal the project file");

  await vaultCommand("decrypt");
  assert.equal(await readFile(storyFile, "utf8"), plaintext);
});
