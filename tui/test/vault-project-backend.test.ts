import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DataDirectoryLock } from "../../server/data-directory-lock.js";
import { VAULT_KEYSLOT_FILE } from "../../server/data-directory-layout.js";
import { publishDataDirectoryOwnerMarker } from "../../server/data-directory-format.js";
import { publishPrivateFileNoReplace } from "../../server/private-file-publication.js";
import {
  createKeyslot,
  encodeKeyslot,
  keyslotWithState
} from "../../shared/vault-cipher.js";
import { runStoryExport } from "../src/export-cli.js";
import { parseImportCommand, runStoryImport } from "../src/import-cli.js";
import { parseCardImportCommand } from "../src/card-import-cli.js";
import { parseLorebookImportCommand } from "../src/lorebook-import-cli.js";
import { parseProfileCommand } from "../src/profile-cli.js";
import { runVaultEncrypt } from "../src/vault-cli.js";
import { openProjectBackend } from "../src/vault-project-backend.js";
import { openSealedVault, openSealedVaultWithPassword } from "../src/vault-open.js";

test("sealed import and export open from a passphrase file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-vault-project-backend-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, ".1667");
  const initializer = new DataDirectoryLock(dataDirectory);
  await initializer.acquire();
  await initializer.release();
  const passwordFile = path.join(root, "vault-password");
  const importFile = path.join(root, "chapter.md");
  const selectedRoot = process.platform === "win32" ? root : `${root}-alias`;
  if (selectedRoot !== root) {
    await symlink(root, selectedRoot, "dir");
    t.after(async () => await rm(selectedRoot, { force: true }));
  }
  await writeFile(passwordFile, "correct horse battery staple\n");
  await writeFile(importFile, "The door opens.\n");
  await runVaultEncrypt(["--data", selectedRoot, "--passphrase-file", passwordFile], { write: () => true });

  await assert.rejects(
    openSealedVault(dataDirectory, nonTtyStreams()),
    /requires a TTY/
  );
  await assert.rejects(openSealedVaultWithPassword(dataDirectory, "wrong password"), /incorrect/);

  const imported = collector();
  await runStoryImport([
    "--data", selectedRoot, "--passphrase-file", passwordFile, importFile
  ], imported.stream, sink());
  assert.match(imported.text(), /imported/);

  const exported = collector();
  await runStoryExport([
    "--data", selectedRoot, "--passphrase-file", passwordFile
  ], exported.stream, sink());
  assert.match(exported.text(), /\.md/);

  await writeFile(path.join(dataDirectory, "vault.json"), "{}");
  await assert.rejects(
    openSealedVault(dataDirectory, nonTtyStreams()),
    /restore .1667\/vault.json from a backup/
  );
  await unlink(path.join(dataDirectory, "vault.json"));
  await assert.rejects(
    openSealedVaultWithPassword(dataDirectory, "correct horse battery staple"),
    /restore .1667\/vault.json from a backup/
  );
});

test("every offline project command accepts --passphrase-file", () => {
  assert.equal(parseImportCommand(["--passphrase-file", "secret", "story.md"]).passphraseFile, "secret");
  assert.equal(parseCardImportCommand([
    "--story", "story", "--passphrase-file=secret", "card.json"
  ]).passphraseFile, "secret");
  assert.equal(parseLorebookImportCommand([
    "--story", "story", "--passphrase-file=secret", "book.json"
  ]).passphraseFile, "secret");
  assert.equal(parseProfileCommand([
    "export", "--passphrase-file=secret"
  ]).passphraseFile, "secret");
});

test("a plain offline open rechecks a format-5 fence under its lock", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-vault-project-race-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, ".1667");
  const initializer = new DataDirectoryLock(dataDirectory);
  await initializer.acquire();
  await initializer.release();
  const project = { root, directory: dataDirectory, source: "explicit", exists: true } as const;

  const error = await plainBackendFailure(project, async (authorityPath) => {
    await publishKeyslot(authorityPath, "sealed");
    await publishDataDirectoryOwnerMarker(authorityPath, 5);
  });
  assert.match(
    error.message,
    /vault became sealed while it was opening; start again with its Vault Password/
  );
});

test("a plain offline open rejects a sealing Keyslot before the format fence rises", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-vault-project-race-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, ".1667");
  const initializer = new DataDirectoryLock(dataDirectory);
  await initializer.acquire();
  await initializer.release();
  const project = { root, directory: dataDirectory, source: "explicit", exists: true } as const;

  const error = await plainBackendFailure(project, async (authorityPath) => {
    await publishKeyslot(authorityPath, "sealing");
  });
  assert.match(
    error.message,
    /vault sealing is incomplete; run '1667 encrypt' again/
  );
});

async function plainBackendFailure(
  project: { readonly root: string; readonly directory: string; readonly source: "explicit"; readonly exists: true },
  changeVault: (authorityPath: string) => Promise<void>
): Promise<Error> {
  try {
    await openProjectBackend(project, null, {
      createWorker: async (options) => {
        const lock = new DataDirectoryLock(project.directory);
        await lock.acquire();
        try {
          await changeVault(lock.authorityPath);
          await options.beforeVaultMigration!(lock.authorityPath);
        } finally {
          await lock.release();
        }
        throw new Error("plain open continued after the vault changed");
      }
    });
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("plain open continued after the vault changed");
}

async function publishKeyslot(
  authorityPath: string,
  state: "sealing" | "sealed"
): Promise<void> {
  const keyslot = await createKeyslot("correct horse battery staple");
  await publishPrivateFileNoReplace(
    path.join(authorityPath, VAULT_KEYSLOT_FILE),
    encodeKeyslot(keyslotWithState(keyslot, state)),
    { label: "Vault Keyslot", maxBytes: 16 * 1024 }
  );
}

function nonTtyStreams(): { input: NodeJS.ReadStream; output: NodeJS.WriteStream } {
  return {
    input: { isTTY: false } as NodeJS.ReadStream,
    output: { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream
  };
}

function collector(): {
  readonly stream: Pick<NodeJS.WriteStream, "write">;
  text(): string;
} {
  const chunks: string[] = [];
  return {
    stream: { write: (chunk: string) => { chunks.push(String(chunk)); return true; } },
    text: () => chunks.join("")
  };
}

function sink(): Pick<NodeJS.WriteStream, "write"> {
  return { write: () => true };
}
