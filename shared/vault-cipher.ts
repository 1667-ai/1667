import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

export const VAULT_SEAL_OVERHEAD = 36;
const VAULT_FILE_MAGIC = Buffer.from([0x00, 0x31, 0x36, 0x36, 0x37, 0x56, 0x01, 0x01]);
const VAULT_FILE_NONCE_BYTES = 12;
const VAULT_KEY_BYTES = 32;
const VAULT_TAG_BYTES = 16;
const VAULT_SALT_BYTES = 32;
const SCRYPT_COST = 131_072;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;

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

export function isSealed(bytes: Uint8Array): boolean {
  return bytes.byteLength >= VAULT_SEAL_OVERHEAD
    && Buffer.from(bytes).subarray(0, VAULT_FILE_MAGIC.byteLength).equals(VAULT_FILE_MAGIC);
}

export function sealVaultBytes(key: Uint8Array, plaintext: Uint8Array): Buffer {
  requireVaultKey(key);
  const nonce = randomBytes(VAULT_FILE_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([VAULT_FILE_MAGIC, nonce, encrypted]);
}

export function unsealVaultBytes(key: Uint8Array, sealed: Uint8Array, label: string): Buffer {
  requireVaultKey(key);
  if (!isSealed(sealed)) return Buffer.from(sealed);
  const bytes = Buffer.from(sealed);
  const nonceStart = VAULT_FILE_MAGIC.byteLength;
  const ciphertextStart = nonceStart + VAULT_FILE_NONCE_BYTES;
  if (bytes.byteLength < ciphertextStart + VAULT_TAG_BYTES) {
    throw new VaultCipherError(`Sealed file is malformed: ${label}`);
  }
  const ciphertextEnd = bytes.byteLength - VAULT_TAG_BYTES;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(nonceStart, ciphertextStart));
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
      nonce: sealed.subarray(VAULT_FILE_MAGIC.byteLength, VAULT_FILE_MAGIC.byteLength + VAULT_FILE_NONCE_BYTES).toString("base64"),
      data: sealed.subarray(VAULT_FILE_MAGIC.byteLength + VAULT_FILE_NONCE_BYTES).toString("base64")
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

export async function unsealKeyslot(password: string, keyslot: VaultKeyslot): Promise<Buffer> {
  const salt = parseBase64(keyslot.kdf.salt, "Vault Keyslot salt");
  const nonce = parseBase64(keyslot.sealedKey.nonce, "Vault Keyslot nonce");
  const data = parseBase64(keyslot.sealedKey.data, "Vault Keyslot data");
  const derivedKey = await deriveKey(password, salt);
  const sealed = Buffer.concat([VAULT_FILE_MAGIC, nonce, data]);
  const key = unsealVaultBytes(derivedKey, sealed, "Vault Keyslot");
  requireVaultKey(key);
  return key;
}

export function keyslotWithState(keyslot: VaultKeyslot, state: VaultKeyslotState): VaultKeyslot {
  return { ...keyslot, state };
}

async function deriveKey(password: string, salt: Uint8Array): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    scrypt(password, salt, VAULT_KEY_BYTES, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
      maxmem: SCRYPT_MAX_MEMORY
    }, (error, derived) => error === null ? resolve(derived) : reject(error));
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
