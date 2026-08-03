import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  createKeyPairSignerFromBytes,
  type KeyPairSigner,
} from "@solana/kit";

const MAX_KEYPAIR_FILE_BYTES = 4 * 1024;

export type KeypairPathPolicy = Readonly<{
  expectedPublicKey?: string;
  allowedRoot?: string;
  requireOwnerOnlyPermissions?: boolean;
}>;

export type CloudRunSecretKeypairPathPolicy = Readonly<{
  /** Absolute mounted directory dedicated to this one service's secret files. */
  allowedRoot: string;
  /** Public identity pinned outside the secret payload. */
  expectedPublicKey: string;
}>;

function isInsideRoot(candidate: string, root: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function parseSolanaCliKeypair(bytes: Uint8Array): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("Executor keypair file is not valid UTF-8 JSON");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  ) {
    throw new TypeError("Executor keypair file must contain exactly 64 byte values");
  }
  return Uint8Array.from(parsed as number[]);
}

/**
 * Loads an existing Solana CLI keypair without ever returning or logging its bytes.
 * The file must be regular, non-symlinked, owner-only by default, and optionally
 * constrained to an operator-configured root. This function never creates a key.
 */
export async function loadExistingKeypairSigner(
  configuredPath: string,
  policy: KeypairPathPolicy = {},
): Promise<KeyPairSigner> {
  if (!configuredPath || !isAbsolute(configuredPath)) {
    throw new TypeError("Executor keypair path must be an absolute path");
  }

  const normalizedPath = resolve(configuredPath);
  const resolvedPath = await realpath(normalizedPath).catch(() => {
    throw new Error("Unable to resolve the configured executor keypair path");
  });
  const configuredStat = await lstat(normalizedPath).catch(() => {
    throw new Error("Unable to inspect the configured executor keypair path");
  });
  if (configuredStat.isSymbolicLink()) {
    throw new Error("Executor keypair path must not traverse a symbolic link");
  }
  if (policy.allowedRoot) {
    const resolvedRoot = await realpath(resolve(policy.allowedRoot)).catch(() => {
      throw new Error("Unable to resolve the configured keypair root");
    });
    if (!isInsideRoot(resolvedPath, resolvedRoot)) {
      throw new Error("Executor keypair path is outside the configured key root");
    }
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(normalizedPath, fsConstants.O_RDONLY | noFollow).catch(() => {
    throw new Error("Unable to open the configured executor keypair");
  });

  let fileBytes: Buffer | undefined;
  let keypairBytes: Uint8Array | undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_KEYPAIR_FILE_BYTES) {
      throw new Error("Executor keypair path must be a small regular file");
    }
    const requireOwnerOnlyPermissions = policy.requireOwnerOnlyPermissions ?? true;
    if (requireOwnerOnlyPermissions && (stat.mode & 0o077) !== 0) {
      throw new Error("Executor keypair file permissions must not grant group or other access");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Executor keypair file must be owned by the current runtime user");
    }

    fileBytes = Buffer.allocUnsafe(stat.size);
    const { bytesRead } = await handle.read(fileBytes, 0, stat.size, 0);
    if (bytesRead !== stat.size) {
      throw new Error("Executor keypair file could not be read completely");
    }
    keypairBytes = parseSolanaCliKeypair(fileBytes);
    const signer = await createKeyPairSignerFromBytes(keypairBytes, false);
    if (policy.expectedPublicKey && signer.address !== policy.expectedPublicKey) {
      throw new Error("Executor keypair does not match the pinned public key");
    }
    return signer;
  } finally {
    keypairBytes?.fill(0);
    fileBytes?.fill(0);
    await handle.close();
  }
}

/**
 * Loads a Secret Manager file mounted by Cloud Run. Unlike the local 0600
 * loader above, this accepts root-owned/read-only files and in-root symlink
 * indirection used by managed secret volumes. The resolved target must remain
 * inside an explicit service-specific root and must not be group/other writable.
 */
export async function loadCloudRunSecretKeypairSigner(
  configuredPath: string,
  policy: CloudRunSecretKeypairPathPolicy,
): Promise<KeyPairSigner> {
  if (!configuredPath || !isAbsolute(configuredPath)) {
    throw new TypeError("Cloud Run secret keypair path must be absolute");
  }
  if (!policy.allowedRoot || !isAbsolute(policy.allowedRoot)) {
    throw new TypeError("Cloud Run secret root must be absolute");
  }
  if (!policy.expectedPublicKey) {
    throw new TypeError("Cloud Run secret keypair requires a pinned public key");
  }

  const [resolvedRoot, resolvedPath] = await Promise.all([
    realpath(resolve(policy.allowedRoot)).catch(() => {
      throw new Error("Unable to resolve the configured Cloud Run secret root");
    }),
    realpath(resolve(configuredPath)).catch(() => {
      throw new Error("Unable to resolve the configured Cloud Run secret keypair path");
    }),
  ]);
  if (!isInsideRoot(resolvedPath, resolvedRoot)) {
    throw new Error("Cloud Run secret keypair resolves outside the configured secret root");
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(resolvedPath, fsConstants.O_RDONLY | noFollow).catch(() => {
    throw new Error("Unable to open the configured Cloud Run secret keypair");
  });
  let fileBytes: Buffer | undefined;
  let keypairBytes: Uint8Array | undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_KEYPAIR_FILE_BYTES) {
      throw new Error("Cloud Run secret keypair must resolve to a small regular file");
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new Error("Cloud Run secret keypair must not be group or other writable");
    }
    fileBytes = Buffer.allocUnsafe(stat.size);
    const { bytesRead } = await handle.read(fileBytes, 0, stat.size, 0);
    if (bytesRead !== stat.size) {
      throw new Error("Cloud Run secret keypair could not be read completely");
    }
    keypairBytes = parseSolanaCliKeypair(fileBytes);
    const signer = await createKeyPairSignerFromBytes(keypairBytes, false);
    if (signer.address !== policy.expectedPublicKey) {
      throw new Error("Cloud Run secret keypair does not match the pinned public key");
    }
    return signer;
  } finally {
    keypairBytes?.fill(0);
    fileBytes?.fill(0);
    await handle.close();
  }
}
