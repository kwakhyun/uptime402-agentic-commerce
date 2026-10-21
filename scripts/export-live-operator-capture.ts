import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Firestore } from "@google-cloud/firestore";
import {
  IdentifierSchema,
  canonicalHash,
  canonicalize,
} from "@uptime402/domain";
import type { z } from "zod";

import { OperatorRunIncidentRequestSchema } from "../apps/control-plane/src/server/operator-boundary.js";
import { FirestoreOperatorIncidentCaptureStore } from "../apps/control-plane/src/server/operator-capture.js";
export { validateStoredOperatorCapture } from "../apps/control-plane/src/server/operator-capture.js";
import {
  readOwnerOnlyOperatorFile,
  writeNewOwnerOnlyOperatorCapture,
} from "./mandate-operator-client.js";
import { parseMandateJson } from "./mandate-json.js";

const MAX_REQUEST_BYTES = 512 * 1024;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function exportLiveOperatorCaptureFromEnvironment(): Promise<{
  outputPath: string;
  resultHash: `sha256:${string}`;
}> {
  const requestBytes = await readOwnerOnlyOperatorFile(
    required("INCIDENT_RUN_REQUEST_PATH"),
    required("INCIDENT_RUN_REQUEST_ROOT"),
    MAX_REQUEST_BYTES,
  );
  let request: z.infer<typeof OperatorRunIncidentRequestSchema>;
  try {
    request = OperatorRunIncidentRequestSchema.parse(
      parseMandateJson(
        new TextDecoder("utf-8", { fatal: true }).decode(requestBytes),
      ),
    );
  } finally {
    requestBytes.fill(0);
  }

  const runSlot = IdentifierSchema.parse(required("CONTROL_PLANE_DEMO_RUN_SLOT"));
  const projectId = required("FIRESTORE_PROJECT_ID");
  const databaseId = process.env.FIRESTORE_DATABASE_ID?.trim() || "(default)";
  const prefix = required("FIRESTORE_COLLECTION_PREFIX");
  if (!/^[a-z][a-z0-9_-]{0,47}$/u.test(prefix)) {
    throw new TypeError("FIRESTORE_COLLECTION_PREFIX is invalid");
  }
  if (process.env.FIRESTORE_EMULATOR_HOST?.trim()) {
    throw new Error("Live operator capture export refuses FIRESTORE_EMULATOR_HOST");
  }

  const captureStore = new FirestoreOperatorIncidentCaptureStore(new Firestore({ projectId, databaseId }), `${prefix}_operator_captures`);
  const { latest: value } = await captureStore.read(runSlot, canonicalHash(request));
  const outputPath = resolve(required("INCIDENT_RUN_CAPTURE_PATH"));
  await writeNewOwnerOnlyOperatorCapture(
    outputPath,
    required("INCIDENT_RUN_CAPTURE_ROOT"),
    value,
  );
  return { outputPath, resultHash: canonicalHash(value.result) };
}

async function main(): Promise<void> {
  process.stdout.write(
    `${canonicalize(await exportLiveOperatorCaptureFromEnvironment())}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Operator capture export failed"}\n`,
    );
    process.exitCode = 1;
  });
}
