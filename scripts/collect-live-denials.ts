import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalHash, canonicalize } from "@uptime402/domain";

import {
  OperatorRunIncidentRequestSchema,
  type AutomaticDenialBindingHashes,
  type AutomaticDenialBindings,
  type AutomaticDenialResults,
} from "../apps/control-plane/src/server/operator-boundary.js";
import {
  VerifiedSettlementCaptureSchema,
  createAutomaticDenialCaptures,
} from "./capture-live-evidence.js";
import {
  FreshRunResponseSchema,
} from "./mandate-run-incident.js";
import {
  readOwnerOnlyOperatorFile,
  writeNewOwnerOnlyOperatorCapture,
} from "./mandate-operator-client.js";
import { parseMandateJson } from "./mandate-json.js";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RUN_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_SETTLEMENT_BYTES = 512 * 1024;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function readOwnerOnlyJson(
  pathName: string,
  rootName: string,
  maximumBytes: number,
): Promise<unknown> {
  const bytes = await readOwnerOnlyOperatorFile(
    required(pathName),
    required(rootName),
    maximumBytes,
  );
  try {
    return parseMandateJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } finally {
    bytes.fill(0);
  }
}

export async function collectLiveDenialsFromEnvironment(): Promise<{
  outputPath: string;
  fragmentHash: `sha256:${string}`;
}> {
  const operatorRequest = OperatorRunIncidentRequestSchema.parse(
    await readOwnerOnlyJson(
      "INCIDENT_RUN_REQUEST_PATH",
      "INCIDENT_RUN_REQUEST_ROOT",
      MAX_REQUEST_BYTES,
    ),
  );
  const fresh = FreshRunResponseSchema.parse(
    await readOwnerOnlyJson(
      "INCIDENT_RUN_CAPTURE_PATH",
      "INCIDENT_RUN_CAPTURE_ROOT",
      MAX_RUN_CAPTURE_BYTES,
    ),
  );
  if (
    fresh.idempotentReplay ||
    fresh.result.primary.outcome !== "recovered" ||
    fresh.result.primary.transactionCreated !== true ||
    !fresh.result.denials ||
    !fresh.result.denialBindings ||
    !fresh.result.denialBindingHashes
  ) {
    throw new Error(
      "Fresh recovered operator capture with both automatic denials is required",
    );
  }
  const settlement = VerifiedSettlementCaptureSchema.parse(
    await readOwnerOnlyJson(
      "DENIAL_SETTLEMENT_CAPTURE_PATH",
      "DENIAL_SETTLEMENT_CAPTURE_ROOT",
      MAX_SETTLEMENT_BYTES,
    ),
  );
  if (fresh.result.primary.txSignature !== settlement.txSignature) {
    throw new Error(
      "Independent settlement signature differs from the recovered operator run",
    );
  }
  const denials = createAutomaticDenialCaptures({
    operatorRequest,
    results: fresh.result.denials as unknown as AutomaticDenialResults,
    bindings: fresh.result.denialBindings as AutomaticDenialBindings,
    bindingHashes:
      fresh.result.denialBindingHashes as AutomaticDenialBindingHashes,
    originalTxSignature: settlement.txSignature,
    originalExplorerUrl: settlement.explorerUrl,
  });
  const outputPath = resolve(required("DENIAL_PROMOTION_FRAGMENT_PATH"));
  await writeNewOwnerOnlyOperatorCapture(
    outputPath,
    required("DENIAL_PROMOTION_FRAGMENT_ROOT"),
    denials,
  );
  return { outputPath, fragmentHash: canonicalHash(denials) };
}

async function main(): Promise<void> {
  const result = await collectLiveDenialsFromEnvironment();
  process.stdout.write(`${canonicalize(result)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Denial collection failed"}\n`,
    );
    process.exitCode = 1;
  });
}
