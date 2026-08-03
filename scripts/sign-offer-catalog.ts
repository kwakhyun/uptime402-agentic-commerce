import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseStrictJson } from "@uptime402/domain";
import { loadExistingKeypairSigner } from "@uptime402/payments";

import {
  VendorOfferCatalogSigningInputSchema,
  signVendorOfferCatalog,
} from "../services/vendor-agent/src/catalog-signing.js";

const MAX_INPUT_BYTES = 256 * 1024;

type Arguments = Readonly<{
  inputPath: string;
  outputPath: string;
  keyPath: string;
  keyRoot: string;
  expectedPublicKey: string;
  keyId: string;
}>;

function parseArguments(argv: readonly string[]): Arguments {
  const normalizedArgv = argv.filter((value) => value !== "--");
  const values = new Map<string, string>();
  for (let index = 0; index < normalizedArgv.length; index += 2) {
    const name = normalizedArgv[index];
    const value = normalizedArgv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new TypeError("Every catalog signing option requires one value");
    }
    if (values.has(name)) throw new TypeError(`Duplicate catalog signing option: ${name}`);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`Missing required option: ${name}`);
    return value;
  };
  const absolute = (name: string): string => {
    const value = required(name);
    if (!isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
    return resolve(value);
  };
  const known = new Set([
    "--input",
    "--output",
    "--key-path",
    "--key-root",
    "--expected-public-key",
    "--key-id",
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new TypeError(`Unknown catalog signing option: ${name}`);
  }
  return {
    inputPath: absolute("--input"),
    outputPath: absolute("--output"),
    keyPath: absolute("--key-path"),
    keyRoot: absolute("--key-root"),
    expectedPublicKey: required("--expected-public-key"),
    keyId: required("--key-id"),
  };
}

async function readSigningInput(path: string): Promise<unknown> {
  const [metadata, resolvedPath] = await Promise.all([lstat(path), realpath(path)]);
  if (!metadata.isFile() || metadata.isSymbolicLink() || resolvedPath !== path) {
    throw new TypeError("Unsigned offer catalog input must be a regular non-symlink file");
  }
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new RangeError("Unsigned offer catalog input must be 1..262144 bytes");
  }
  return parseStrictJson(await readFile(path, "utf8"));
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArguments(argv);
  const input = VendorOfferCatalogSigningInputSchema.parse(
    await readSigningInput(options.inputPath),
  );
  const signer = await loadExistingKeypairSigner(options.keyPath, {
    allowedRoot: options.keyRoot,
    expectedPublicKey: options.expectedPublicKey,
    requireOwnerOnlyPermissions: true,
  });
  const catalog = await signVendorOfferCatalog({
    input,
    signer,
    expectedSignerPublicKey: options.expectedPublicKey,
    keyId: options.keyId,
  });
  // Exclusive creation prevents an accidental overwrite of an already-pinned catalog.
  await writeFile(options.outputPath, `${JSON.stringify(catalog, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write("Signed vendor offer catalog created without generating key material.\n");
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Catalog signing failed"}\n`);
    process.exitCode = 1;
  });
}
