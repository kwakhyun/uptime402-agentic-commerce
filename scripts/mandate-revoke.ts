import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  IdentifierSchema,
  TimestampSchema,
  canonicalize,
} from "@uptime402/domain";
import { z } from "zod";

import {
  postProtectedOperatorJson,
  readOperatorOidcToken,
} from "./mandate-operator-client.js";

const RevokeResponseSchema = z
  .object({
    schemaVersion: z.literal("1"),
    separation: z.literal("application-role"),
    idempotentReplay: z.boolean(),
    result: z
      .object({
        mandateId: IdentifierSchema,
        version: z.number().int().positive(),
        event: z.literal("revoked"),
        at: TimestampSchema,
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

export async function revokeMandateFromEnvironment(): Promise<
  z.infer<typeof RevokeResponseSchema>
> {
  const mandateId = IdentifierSchema.parse(required("MANDATE_ID"));
  const reason = required("MANDATE_REVOKE_REASON");
  if (reason.length > 500) throw new TypeError("MANDATE_REVOKE_REASON is too long");
  const revokedAt = TimestampSchema.parse(
    process.env.MANDATE_REVOKED_AT?.trim() || new Date().toISOString(),
  );
  const token = await readOperatorOidcToken(
    required("OPERATOR_ID_TOKEN_PATH"),
    required("OPERATOR_ID_TOKEN_ROOT"),
  );
  const response = await postProtectedOperatorJson({
    controlPlaneOrigin: required("CONTROL_PLANE_ORIGIN"),
    path: `/api/operator/mandates/${encodeURIComponent(mandateId)}/revoke`,
    token,
    body: { schemaVersion: "1", revokedAt, reason },
    maxResponseBytes: 64 * 1024,
  });
  return RevokeResponseSchema.parse(response.body);
}

async function main(): Promise<void> {
  const response = await revokeMandateFromEnvironment();
  process.stdout.write(`${canonicalize(response)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Mandate revoke failed"}\n`,
    );
    process.exitCode = 1;
  });
}
