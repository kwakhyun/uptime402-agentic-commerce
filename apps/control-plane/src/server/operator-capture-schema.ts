import { Base58Schema, IdentifierSchema } from "@uptime402/domain";
import { z } from "zod";

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
