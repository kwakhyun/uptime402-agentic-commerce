import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  Base58Schema,
  MandateSchema,
  MandateUnsignedSchema,
  canonicalize,
  computeMandateHash,
  type Mandate,
  type MandateUnsigned,
} from "@uptime402/domain";
import {
  loadExistingKeypairSigner,
  signEnvelope,
} from "@uptime402/payments";
import type { KeyPairSigner } from "@solana/kit";

import { parseMandateJson } from "./mandate-json.js";

const MAX_MANDATE_FILE_BYTES = 256 * 1024;

export type MandateSigningIdentity = Readonly<{
  signer: KeyPairSigner;
  keyId: string;
}>;

export async function buildSignedMandate(
  rawUnsigned: unknown,
  identity: MandateSigningIdentity,
): Promise<Mandate> {
  const unsigned = MandateUnsignedSchema.parse(rawUnsigned);
  const signed = await signEnvelope(unsigned, MandateUnsignedSchema, identity);
  return MandateSchema.parse({
    ...unsigned,
    mandateHash: computeMandateHash(unsigned),
    attestation: {
      kid: identity.keyId,
      algorithm: "EdDSA",
      signature: signed.signature,
    },
  });
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function inside(candidate: string, root: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

async function readSmallRegularFile(
  configuredPath: string,
  allowedRoot: string,
): Promise<Uint8Array> {
  if (!isAbsolute(configuredPath) || !isAbsolute(allowedRoot)) {
    throw new TypeError("Mandate input and root paths must be absolute");
  }
  const [resolvedPath, resolvedRoot] = await Promise.all([
    realpath(resolve(configuredPath)),
    realpath(resolve(allowedRoot)),
  ]);
  if (!inside(resolvedPath, resolvedRoot)) {
    throw new Error("Mandate input resolves outside its configured root");
  }
  const configuredStat = await lstat(resolve(configuredPath));
  if (configuredStat.isSymbolicLink()) {
    throw new Error("Mandate input path must not be a symbolic link");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(resolvedPath, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_MANDATE_FILE_BYTES) {
      throw new Error("Mandate input must be a small regular file");
    }
    const bytes = new Uint8Array(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, stat.size, 0);
    if (bytesRead !== stat.size) throw new Error("Mandate input read was incomplete");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeNewOwnerOnlyFile(
  configuredPath: string,
  allowedRoot: string,
  contents: string,
): Promise<void> {
  if (!isAbsolute(configuredPath) || !isAbsolute(allowedRoot)) {
    throw new TypeError("Mandate output and root paths must be absolute");
  }
  const [parent, resolvedRoot] = await Promise.all([
    realpath(dirname(resolve(configuredPath))),
    realpath(resolve(allowedRoot)),
  ]);
  if (!inside(parent, resolvedRoot)) {
    throw new Error("Mandate output resolves outside its configured root");
  }
  await writeFile(resolve(configuredPath), contents, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function signMandateFromEnvironment(): Promise<{
  outputPath: string;
  mandateId: string;
  mandateHash: string;
  signerPublicKey: string;
}> {
  const unsignedPath = required("MANDATE_UNSIGNED_PATH");
  const unsignedRoot = required("MANDATE_UNSIGNED_ROOT");
  const outputPath = required("MANDATE_OUTPUT_PATH");
  const outputRoot = required("MANDATE_OUTPUT_ROOT");
  const signerPath = required("MANDATE_SIGNER_KEYPAIR_PATH");
  const signerRoot = required("MANDATE_SIGNER_KEYPAIR_ROOT");
  const expectedPublicKey = Base58Schema.parse(
    required("MANDATE_SIGNER_PUBLIC_KEY"),
  );
  const keyId = required("MANDATE_SIGNER_KEY_ID");
  if (keyId.length > 256) throw new TypeError("MANDATE_SIGNER_KEY_ID is too long");
  if (resolve(outputPath) === resolve(unsignedPath) || resolve(outputPath) === resolve(signerPath)) {
    throw new Error("Mandate output must not overwrite an input or signer file");
  }

  const unsignedBytes = await readSmallRegularFile(unsignedPath, unsignedRoot);
  let rawUnsigned: unknown;
  try {
    rawUnsigned = parseMandateJson(
      new TextDecoder("utf-8", { fatal: true }).decode(unsignedBytes),
    );
  } finally {
    unsignedBytes.fill(0);
  }
  const signer = await loadExistingKeypairSigner(signerPath, {
    allowedRoot: signerRoot,
    expectedPublicKey,
    requireOwnerOnlyPermissions: true,
  });
  const mandate = await buildSignedMandate(rawUnsigned, { signer, keyId });
  await writeNewOwnerOnlyFile(outputPath, outputRoot, `${canonicalize(mandate)}\n`);
  return {
    outputPath: resolve(outputPath),
    mandateId: mandate.id,
    mandateHash: mandate.mandateHash,
    signerPublicKey: signer.address,
  };
}

async function main(): Promise<void> {
  const result = await signMandateFromEnvironment();
  process.stdout.write(
    `${canonicalize({
      outputPath: result.outputPath,
      mandateId: result.mandateId,
      mandateHash: result.mandateHash,
      signerPublicKey: result.signerPublicKey,
      keyGenerated: false,
    })}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Mandate signing failed"}\n`,
    );
    process.exitCode = 1;
  });
}

export type { MandateUnsigned };
