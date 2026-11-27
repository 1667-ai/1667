import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

export const VAULT_SEAL_OVERHEAD = 36;
/**
 * The first seven header bytes never change, so every build can recognize a
 * sealed file. The eighth byte is the seal version, which selects what the
 * authentication tag covers.
 */
const VAULT_FILE_PREFIX = Buffer.from([0x00, 0x31, 0x36, 0x36, 0x37, 0x56, 0x01]);
const VAULT_FILE_HEADER_BYTES = VAULT_FILE_PREFIX.byteLength + 1;
const VAULT_FILE_NONCE_BYTES = 12;
const VAULT_KEY_BYTES = 32;
const VAULT_TAG_BYTES = 16;
const VAULT_SALT_BYTES = 32;
const SCRYPT_COST = 131_072;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;

/**
 * Seal version 1 authenticates the ciphertext alone. Every file sealed before
 * location binding existed carries it, so the reader must keep opening it
 * unchanged and forever.
 */
export const VAULT_SEAL_VERSION_UNBOUND = 1;
/**
 * Seal version 2 additionally authenticates the header and the file's binding
 * (`server/vault-seal-binding.ts`), which ties one ciphertext to one location.
 * Binding the header too means a flipped version byte fails the tag rather
 * than selecting a weaker rule.
 */
export const VAULT_SEAL_VERSION_BOUND = 2;

export type VaultKeyslotState = "sealing" | "sealed" | "unsealing";

export interface VaultKeyslot {
  readonly format: 1;
  readonly kdf: {
    readonly name: "scrypt";
    readonly n: 131072;
    readonly r: 8;
    readonly p: 1;
    readonly salt: string;
  };
  readonly sealedKey: {
    readonly nonce: string;
    readonly data: string;
  };
  readonly state: VaultKeyslotState;
}

export class VaultCipherError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VaultCipherError";
  }
}

/**
 * A sealed file whose version this build does not implement. It is reported
 * apart from an authentication failure because the two need opposite handling:
 * an unreadable version means a newer build wrote this vault, and treating it
 * as corrupt would seal it a second time.
 */
export class VaultSealVersionError extends VaultCipherError {
  constructor(readonly version: number, label: string) {
    super(`Sealed file needs a newer 1667 to open (seal version ${version}): ${label}`);
    this.name = "VaultSealVersionError";
  }
}

/** A version-2 file read without the binding it authenticates against. */
export class VaultSealBindingError extends VaultCipherError {
  constructor(label: string) {
    super(`Sealed file needs its location binding to open: ${label}`);
    this.name = "VaultSealBindingError";
  }
}

export function isSealed(bytes: Uint8Array): boolean {
  return bytes.byteLength >= VAULT_SEAL_OVERHEAD
    && Buffer.from(bytes).subarray(0, VAULT_FILE_PREFIX.byteLength).equals(VAULT_FILE_PREFIX);
}

/** The seal version of a sealed file. Call `isSealed` first. */
export function sealVersion(sealed: Uint8Array): number {
  return Buffer.from(sealed)[VAULT_FILE_PREFIX.byteLength]!;
}

/**
 * Seal bytes for one vault. Supplying `binding` writes a version-2 file that
 * authenticates that binding; omitting it writes a version-1 file.
 */
export function sealVaultBytes(
  key: Uint8Array,
  plaintext: Uint8Array,
  binding?: Uint8Array
): Buffer {
  requireVaultKey(key);
  const version = binding === undefined
    ? VAULT_SEAL_VERSION_UNBOUND
    : VAULT_SEAL_VERSION_BOUND;
  const header = sealHeader(version);
  const nonce = randomBytes(VAULT_FILE_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (binding !== undefined) cipher.setAAD(additionalData(header, binding));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([header, nonce, encrypted]);
}

/**
 * Unseal bytes for one vault. `binding` is required to open a version-2 file
 * and ignored for a version-1 file, so one call site serves a vault that holds
 * both.
 */
export function unsealVaultBytes(
  key: Uint8Array,
  sealed: Uint8Array,
  label: string,
  binding?: Uint8Array
): Buffer {
  requireVaultKey(key);
  if (!isSealed(sealed)) return Buffer.from(sealed);
  const bytes = Buffer.from(sealed);
  const nonceStart = VAULT_FILE_HEADER_BYTES;
  const ciphertextStart = nonceStart + VAULT_FILE_NONCE_BYTES;
  if (bytes.byteLength < ciphertextStart + VAULT_TAG_BYTES) {
    throw new VaultCipherError(`Sealed file is malformed: ${label}`);
  }
  const version = sealVersion(bytes);
  if (version !== VAULT_SEAL_VERSION_UNBOUND && version !== VAULT_SEAL_VERSION_BOUND) {
    throw new VaultSealVersionError(version, label);
  }
  if (version === VAULT_SEAL_VERSION_BOUND && binding === undefined) {
    throw new VaultSealBindingError(label);
  }
  const ciphertextEnd = bytes.byteLength - VAULT_TAG_BYTES;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(nonceStart, ciphertextStart));
    if (version === VAULT_SEAL_VERSION_BOUND) {
      decipher.setAAD(additionalData(bytes.subarray(0, VAULT_FILE_HEADER_BYTES), binding!));
    }
    decipher.setAuthTag(bytes.subarray(ciphertextEnd));
    return Buffer.concat([decipher.update(bytes.subarray(ciphertextStart, ciphertextEnd)), decipher.final()]);
  } catch (error) {
    throw new VaultCipherError(`Sealed file authentication failed: ${label}`, { cause: error });
  }
}

export async function createKeyslot(
  password: string,
  vaultKey: Uint8Array = randomBytes(VAULT_KEY_BYTES)
): Promise<VaultKeyslot> {
  requireVaultKey(vaultKey);
  const salt = randomBytes(VAULT_SALT_BYTES);
  const kdf = {
    name: "scrypt" as const,
    n: SCRYPT_COST as 131072,
    r: SCRYPT_BLOCK_SIZE as 8,
    p: SCRYPT_PARALLELIZATION as 1,
    salt: salt.toString("base64")
  };
  const derivedKey = await deriveKey(password, salt);
  const sealed = sealVaultBytes(derivedKey, vaultKey);
  return {
    format: 1,
    kdf,
    sealedKey: {
      nonce: sealed.subarray(VAULT_FILE_HEADER_BYTES, VAULT_FILE_HEADER_BYTES + VAULT_FILE_NONCE_BYTES).toString("base64"),
      data: sealed.subarray(VAULT_FILE_HEADER_BYTES + VAULT_FILE_NONCE_BYTES).toString("base64")
    },
    state: "sealing"
  };
}

/** Decode the only supported canonical Keyslot record. */
export function parseKeyslot(bytes: Uint8Array): VaultKeyslot {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new VaultCipherError("Vault Keyslot is not valid JSON", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultCipherError("Vault Keyslot is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.format !== 1 || !isExactKeys(record, ["format", "kdf", "sealedKey", "state"])) {
    throw new VaultCipherError("Vault Keyslot has an unsupported format");
  }
  const kdf = requireRecord(record.kdf, "Vault Keyslot kdf");
  const sealedKey = requireRecord(record.sealedKey, "Vault Keyslot sealedKey");
  if (!isExactKeys(kdf, ["name", "n", "r", "p", "salt"])
    || kdf.name !== "scrypt" || kdf.n !== SCRYPT_COST || kdf.r !== SCRYPT_BLOCK_SIZE || kdf.p !== SCRYPT_PARALLELIZATION) {
    throw new VaultCipherError("Vault Keyslot has unsupported derivation parameters");
  }
  if (!isExactKeys(sealedKey, ["nonce", "data"])
    || !isVaultKeyslotState(record.state)
    || typeof kdf.salt !== "string" || typeof sealedKey.nonce !== "string" || typeof sealedKey.data !== "string") {
    throw new VaultCipherError("Vault Keyslot has invalid fields");
  }
  const salt = parseBase64(kdf.salt, "Vault Keyslot salt");
  const nonce = parseBase64(sealedKey.nonce, "Vault Keyslot nonce");
  const data = parseBase64(sealedKey.data, "Vault Keyslot data");
  if (salt.byteLength !== VAULT_SALT_BYTES || nonce.byteLength !== VAULT_FILE_NONCE_BYTES
    || data.byteLength !== VAULT_KEY_BYTES + VAULT_TAG_BYTES) {
    throw new VaultCipherError("Vault Keyslot field length is invalid");
  }
  return {
    format: 1,
    kdf: { name: "scrypt", n: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION, salt: kdf.salt },
    sealedKey: { nonce: sealedKey.nonce, data: sealedKey.data },
    state: record.state
  };
}

export function encodeKeyslot(keyslot: VaultKeyslot): Buffer {
  return Buffer.from(`${JSON.stringify(keyslot)}\n`, "utf8");
}

/**
 * The Keyslot holds the Vault Key, not project bytes, and has one fixed
 * location of its own, so it stays a version-1 seal.
 */
export async function unsealKeyslot(password: string, keyslot: VaultKeyslot): Promise<Buffer> {
  const salt = parseBase64(keyslot.kdf.salt, "Vault Keyslot salt");
  const nonce = parseBase64(keyslot.sealedKey.nonce, "Vault Keyslot nonce");
  const data = parseBase64(keyslot.sealedKey.data, "Vault Keyslot data");
  const derivedKey = await deriveKey(password, salt);
  const sealed = Buffer.concat([sealHeader(VAULT_SEAL_VERSION_UNBOUND), nonce, data]);
  const key = unsealVaultBytes(derivedKey, sealed, "Vault Keyslot");
  requireVaultKey(key);
  return key;
}

export function keyslotWithState(keyslot: VaultKeyslot, state: VaultKeyslotState): VaultKeyslot {
  return { ...keyslot, state };
}

function sealHeader(version: number): Buffer {
  return Buffer.concat([VAULT_FILE_PREFIX, Buffer.from([version])]);
}

function additionalData(header: Uint8Array, binding: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(header), Buffer.from(binding)]);
}

async function deriveKey(password: string, salt: Uint8Array): Promise<Buffer> {
  // Node.js reports a successful derivation with `null`. Bun reports it with
  // `undefined`. The standalone executable holds the Bun runtime, so a test
  // against `null` alone rejects every successful derivation there.
  return await new Promise((resolve, reject) => {
    scrypt(password, salt, VAULT_KEY_BYTES, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
      maxmem: SCRYPT_MAX_MEMORY
    }, (error, derived) => error == null ? resolve(derived) : reject(error));
  });
}

function requireVaultKey(key: Uint8Array): void {
  if (key.byteLength !== VAULT_KEY_BYTES) throw new VaultCipherError("Vault Key must be 32 bytes");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultCipherError(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function isExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isVaultKeyslotState(value: unknown): value is VaultKeyslotState {
  return value === "sealing" || value === "sealed" || value === "unsealing";
}

function parseBase64(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== value) {
    throw new VaultCipherError(`${label} is not canonical base64`);
  }
  return bytes;
}
