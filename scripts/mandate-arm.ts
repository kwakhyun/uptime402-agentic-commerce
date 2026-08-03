import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MandateSchema, canonicalize } from "@uptime402/domain";
import { z } from "zod";

import {
  postProtectedOperatorJson,
  readOperatorOidcToken,
  readOwnerOnlyOperatorFile,
} from "./mandate-operator-client.js";
import { parseMandateJson } from "./mandate-json.js";

const ArmResponseSchema = z
  .object({
    schemaVersion: z.literal("1"),
    separation: z.literal("application-role"),
    idempotentReplay: z.boolean(),
    result: z
      .object({
        mandateId: z.string().min(1).max(128),
        version: z.number().int().positive(),
        event: z.literal("armed"),
        at: z.string().datetime({ offset: true }),
        separation: z.literal("application-role"),
      })
      .strict(),
  })
  .strict();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function armMandateFromEnvironment(): Promise<z.infer<typeof ArmResponseSchema>> {
  const signedMandateBytes = await readOwnerOnlyOperatorFile(
    required("SIGNED_MANDATE_PATH"),
    required("SIGNED_MANDATE_ROOT"),
    256 * 1024,
  );
  let mandate: z.infer<typeof MandateSchema>;
  try {
    mandate = MandateSchema.parse(
      parseMandateJson(
        new TextDecoder("utf-8", { fatal: true }).decode(signedMandateBytes),
      ),
    );
  } finally {
    signedMandateBytes.fill(0);
  }
  const token = await readOperatorOidcToken(
    required("OPERATOR_ID_TOKEN_PATH"),
    required("OPERATOR_ID_TOKEN_ROOT"),
  );
  const response = await postProtectedOperatorJson({
    controlPlaneOrigin: required("CONTROL_PLANE_ORIGIN"),
    path: "/api/operator/mandates/arm",
    token,
    body: { schemaVersion: "1", mandate },
    maxResponseBytes: 64 * 1024,
  });
  return ArmResponseSchema.parse(response.body);
}

async function main(): Promise<void> {
  const response = await armMandateFromEnvironment();
  process.stdout.write(`${canonicalize(response)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Mandate arm failed"}\n`,
    );
    process.exitCode = 1;
  });
}
