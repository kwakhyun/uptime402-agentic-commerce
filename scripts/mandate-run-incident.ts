import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  Base58Schema,
  ExecutionPolicySchema,
  IdentifierSchema,
  TimestampSchema,
  canonicalHash,
  canonicalize,
} from "@uptime402/domain";
import { z } from "zod";

import {
  postProtectedOperatorJson,
  readOperatorOidcToken,
  readOwnerOnlyOperatorFile,
  writeNewOwnerOnlyOperatorCapture,
} from "./mandate-operator-client.js";
import { parseMandateJson } from "./mandate-json.js";

const IncidentExecutionInputSchema = z
  .object({
    incident: z
      .object({
        id: IdentifierSchema,
        service: z.string().min(1).max(256),
        signal: z.string().min(1).max(256),
        observedAt: TimestampSchema,
        healthBefore: z.enum(["degraded", "down"]),
        rawTelemetry: z
          .object({
            errorClass: z.string().min(1).max(128),
            statusCode: z.number().int().min(100).max(599).optional(),
            latencyMs: z.number().finite().nonnegative().max(3_600_000).optional(),
            failureRate: z.number().finite().min(0).max(1).optional(),
            message: z.string().max(20_000).optional(),
          })
          .strict(),
      })
      .strict(),
    requiredCapability: IdentifierSchema,
    mandateId: IdentifierSchema,
    subject: z.string().min(1).max(256),
    operationId: IdentifierSchema,
    paymentId: IdentifierSchema,
    nonce: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
    executionPolicy: ExecutionPolicySchema,
  })
  .strict();

export const RunRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    request: IncidentExecutionInputSchema,
    denialRequests: z
      .object({
        expectedPerTransactionLimitBaseUnits: z.literal("20000"),
        overTransactionLimit: IncidentExecutionInputSchema,
        replay: IncidentExecutionInputSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const denials = value.denialRequests;
    if (!denials) return;
    const primary = value.request;
    const overCap = denials.overTransactionLimit;
    const replay = denials.replay;
    const shared = [overCap, replay].every(
      (denial) =>
        denial.mandateId === primary.mandateId &&
        denial.incident.id !== primary.incident.id &&
        denial.idempotencyKey !== primary.idempotencyKey &&
        denial.operationId !== primary.operationId &&
        denial.requiredCapability === primary.requiredCapability &&
        denial.subject === primary.subject &&
        denial.executionPolicy.policyHash === primary.executionPolicy.policyHash,
    );
    const valid =
      shared &&
      overCap.paymentId !== primary.paymentId &&
      overCap.nonce !== primary.nonce &&
      overCap.paymentId !== replay.paymentId &&
      overCap.nonce !== replay.nonce &&
      overCap.idempotencyKey !== replay.idempotencyKey &&
      overCap.incident.id !== replay.incident.id &&
      overCap.operationId !== replay.operationId &&
      canonicalHash(overCap.incident.rawTelemetry) !==
        canonicalHash(primary.incident.rawTelemetry) &&
      replay.paymentId !== primary.paymentId &&
      replay.nonce === primary.nonce &&
      replay.incident.service === primary.incident.service &&
      replay.incident.signal === primary.incident.signal &&
      replay.incident.healthBefore === primary.incident.healthBefore &&
      canonicalHash(replay.incident.rawTelemetry) ===
        canonicalHash(primary.incident.rawTelemetry);
    if (!valid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["denialRequests"],
        message: "Automatic denial requests are not bound to the dual-denial contract",
      });
    }
  });

export const FreshRunResponseSchema = z
  .object({
    schemaVersion: z.literal("1"),
    separation: z.literal("application-role"),
    idempotentReplay: z.literal(false),
    result: z.object({
      primary: z
        .object({
          outcome: z.enum(["recovered", "denied", "reconciliation_required"]),
          transactionCreated: z.boolean(),
          txSignature: z.union([Base58Schema, z.null()]),
          selectedOffer: z
            .object({
              payload: z
                .object({
                  offerId: IdentifierSchema,
                  amountBaseUnits: z.string().regex(/^[1-9][0-9]*$/u),
                })
                .passthrough(),
            })
            .passthrough(),
        })
        .passthrough(),
      denials: z
        .object({
          overTransactionLimit: z
            .object({
              outcome: z.literal("denied"),
              reasonCode: z.literal("amount.per_transaction_limit"),
              transactionCreated: z.literal(false),
              txSignature: z.null(),
              selectedOffer: z
                .object({
                  payload: z
                    .object({
                      offerId: IdentifierSchema,
                      amountBaseUnits: z.string().regex(/^[1-9][0-9]*$/u),
                    })
                    .passthrough(),
                })
                .passthrough(),
            })
            .passthrough(),
          replay: z
            .object({
              outcome: z.literal("denied"),
              reasonCode: z.literal("identifier.nonce_fresh"),
              transactionCreated: z.literal(false),
              txSignature: z.null(),
            })
            .passthrough(),
        })
        .strict()
        .nullable(),
      denialBindings: z
        .object({
          overTransactionLimit: z
            .object({
              denialType: z.literal("perTransactionLimit"),
              mandateId: IdentifierSchema,
              deniedPaymentId: IdentifierSchema,
              deniedIncidentId: IdentifierSchema,
              deniedNonce: IdentifierSchema,
              deniedIdempotencyKey: IdentifierSchema,
              selectedOfferId: IdentifierSchema,
              attemptedAmountBaseUnits: z.string().regex(/^[1-9][0-9]*$/u),
              reasonCode: z.literal("amount.per_transaction_limit"),
              transactionCreated: z.literal(false),
              txSignature: z.null(),
            })
            .strict(),
          replay: z
            .object({
              identifierType: z.literal("nonce"),
              mandateId: IdentifierSchema,
              originalPaymentId: IdentifierSchema,
              deniedPaymentId: IdentifierSchema,
              originalIncidentId: IdentifierSchema,
              deniedIncidentId: IdentifierSchema,
              originalNonce: IdentifierSchema,
              deniedNonce: IdentifierSchema,
              originalIdempotencyKey: IdentifierSchema,
              deniedIdempotencyKey: IdentifierSchema,
              reasonCode: z.literal("identifier.nonce_fresh"),
              transactionCreated: z.literal(false),
              txSignature: z.null(),
            })
            .strict(),
        })
        .strict()
        .nullable(),
      denialBindingHashes: z
        .object({
          overTransactionLimit: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
          replay: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        })
        .strict()
        .nullable(),
    }).strict(),
  })
  .strict();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function runIncidentFromEnvironment(): Promise<{
  capturePath: string;
  resultHash: `sha256:${string}`;
  outcome: "recovered" | "denied" | "reconciliation_required";
  transactionCreated: boolean;
}> {
  const requestBytes = await readOwnerOnlyOperatorFile(
    required("INCIDENT_RUN_REQUEST_PATH"),
    required("INCIDENT_RUN_REQUEST_ROOT"),
  );
  let request: z.infer<typeof RunRequestSchema>;
  try {
    request = RunRequestSchema.parse(
      parseMandateJson(new TextDecoder("utf-8", { fatal: true }).decode(requestBytes)),
    );
  } finally {
    requestBytes.fill(0);
  }
  const token = await readOperatorOidcToken(
    required("OPERATOR_ID_TOKEN_PATH"),
    required("OPERATOR_ID_TOKEN_ROOT"),
  );
  const response = await postProtectedOperatorJson({
    controlPlaneOrigin: required("CONTROL_PLANE_ORIGIN"),
    path: "/api/operator/incidents/run",
    token,
    body: request,
  });
  const fresh = FreshRunResponseSchema.parse(response.body);
  if (
    (request.denialRequests === undefined) !== (fresh.result.denials === null) ||
    (request.denialRequests === undefined) !== (fresh.result.denialBindings === null) ||
    (request.denialRequests === undefined) !==
      (fresh.result.denialBindingHashes === null)
  ) {
    throw new Error("Fresh incident response omitted or invented the requested dual-denial proof");
  }
  if (
    request.denialRequests &&
    fresh.result.denials &&
    fresh.result.denialBindings &&
    fresh.result.denialBindingHashes &&
    (fresh.result.denialBindings.overTransactionLimit.deniedPaymentId !==
      request.denialRequests.overTransactionLimit.paymentId ||
      fresh.result.denialBindings.overTransactionLimit.deniedNonce !==
        request.denialRequests.overTransactionLimit.nonce ||
      fresh.result.denialBindings.overTransactionLimit.attemptedAmountBaseUnits !==
        fresh.result.denials.overTransactionLimit.selectedOffer.payload.amountBaseUnits ||
      fresh.result.denialBindings.replay.originalPaymentId !== request.request.paymentId ||
      fresh.result.denialBindings.replay.deniedPaymentId !==
        request.denialRequests.replay.paymentId ||
      fresh.result.denialBindings.replay.originalNonce !== request.request.nonce ||
      fresh.result.denialBindings.replay.deniedNonce !== request.denialRequests.replay.nonce ||
      fresh.result.denialBindingHashes.overTransactionLimit !==
        canonicalHash(fresh.result.denialBindings.overTransactionLimit) ||
      fresh.result.denialBindingHashes.replay !==
        canonicalHash(fresh.result.denialBindings.replay))
  ) {
    throw new Error("Fresh incident response denial bindings do not match the request/results");
  }
  if (request.denialRequests && fresh.result.denials) {
    const expectedLimit = BigInt(
      request.denialRequests.expectedPerTransactionLimitBaseUnits,
    );
    if (
      BigInt(fresh.result.primary.selectedOffer.payload.amountBaseUnits) > expectedLimit ||
      BigInt(
        fresh.result.denials.overTransactionLimit.selectedOffer.payload
          .amountBaseUnits,
      ) <= expectedLimit
    ) {
      throw new Error(
        "Incident capture does not prove an under-cap primary and over-cap counterfactual offer",
      );
    }
  }
  const capturePath = resolve(required("INCIDENT_RUN_CAPTURE_PATH"));
  await writeNewOwnerOnlyOperatorCapture(
    capturePath,
    required("INCIDENT_RUN_CAPTURE_ROOT"),
    fresh,
  );
  return {
    capturePath,
    resultHash: canonicalHash(fresh.result),
    outcome: fresh.result.primary.outcome,
    transactionCreated: fresh.result.primary.transactionCreated,
  };
}

async function main(): Promise<void> {
  const result = await runIncidentFromEnvironment();
  process.stdout.write(
    `${canonicalize({
      capturePath: result.capturePath,
      resultHash: result.resultHash,
      outcome: result.outcome,
      transactionCreated: result.transactionCreated,
    })}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Incident run failed"}\n`,
    );
    process.exitCode = 1;
  });
}
