import { z } from "zod";

import { canonicalHash, omitKeys } from "./canonical.js";

const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE_UNITS_PATTERN = /^(0|[1-9][0-9]*)$/;
const POSITIVE_BASE_UNITS_PATTERN = /^[1-9][0-9]*$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CAIP2_SOLANA_PATTERN = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/;

export const IdentifierSchema = z.string().min(1).max(128).regex(ID_PATTERN);
export const Base58Schema = z.string().min(32).max(160).regex(BASE58_PATTERN);
export const BaseUnitsSchema = z.string().regex(BASE_UNITS_PATTERN);
export const PositiveBaseUnitsSchema = z.string().regex(POSITIVE_BASE_UNITS_PATTERN);
export const Sha256Schema = z.string().regex(SHA256_PATTERN);
export const TimestampSchema = z.string().datetime({ offset: true });
export const HttpsUrlSchema = z.string().url().refine((value) => value.startsWith("https://"), "Expected HTTPS URL");
export const SolanaNetworkIdSchema = z.string().regex(CAIP2_SOLANA_PATTERN);

export function SignedEnvelopeSchema<TSchema extends z.ZodTypeAny>(payloadSchema: TSchema) {
  return z
    .object({
      payload: payloadSchema,
      signer: Base58Schema,
      keyId: z.string().min(1).max(256),
      signature: Base58Schema,
    })
    .strict();
}

export const ClusterLabelSchema = z.enum(["devnet", "mainnet-beta"]);

export function deriveSolanaCaip2NetworkId(genesisHash: string): `solana:${string}` {
  if (genesisHash.length < 32 || !BASE58_PATTERN.test(genesisHash)) {
    throw new TypeError("Genesis hash must be a Base58 string at least 32 characters long");
  }
  return `solana:${genesisHash.slice(0, 32)}`;
}

export const NetworkIdentitySchema = z
  .object({
    clusterLabel: ClusterLabelSchema,
    genesisHash: z.string().min(32).max(64).regex(BASE58_PATTERN),
    x402NetworkId: SolanaNetworkIdSchema,
    sdkNetworkId: z.string().min(1).max(128),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.x402NetworkId !== deriveSolanaCaip2NetworkId(value.genesisHash)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["x402NetworkId"],
        message: "CAIP-2 reference must be the first 32 Base58 characters of genesisHash",
      });
    }
  });

export type NetworkIdentity = z.infer<typeof NetworkIdentitySchema>;

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" as const;
export const DEVNET_X402_NETWORK_ID = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as const;
export const USDC_DECIMALS = 6 as const;

export function createNetworkIdentity(input: {
  clusterLabel: NetworkIdentity["clusterLabel"];
  genesisHash: string;
  sdkNetworkId: string;
}): NetworkIdentity {
  return NetworkIdentitySchema.parse({
    ...input,
    x402NetworkId: deriveSolanaCaip2NetworkId(input.genesisHash),
  });
}

export const EdDsaAttestationSchema = z
  .object({
    kid: z.string().min(1).max(256),
    algorithm: z.literal("EdDSA"),
    signature: z.string().min(1).max(512),
  })
  .strict();

const MandateUnsignedShape = {
  id: IdentifierSchema,
  subject: z.string().min(1).max(256),
  clusterLabel: ClusterLabelSchema,
  assetMint: Base58Schema,
  perTransactionLimitBaseUnits: PositiveBaseUnitsSchema,
  incidentLimitBaseUnits: PositiveBaseUnitsSchema,
  dailyLimitBaseUnits: PositiveBaseUnitsSchema,
  allowedRecipients: z.array(Base58Schema).min(1).max(64),
  allowedCapabilities: z.array(IdentifierSchema).min(1).max(64),
  allowedVendorOrigins: z.array(HttpsUrlSchema).min(1).max(64),
  allowedAgentCardHashes: z.array(Sha256Schema).min(1).max(64),
  notBefore: TimestampSchema,
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.optional(),
  nonce: IdentifierSchema,
  issuerPrincipal: z.string().min(1).max(256),
  issuedAt: TimestampSchema,
  executionPolicyHash: Sha256Schema,
  protocolLabel: z.enum(["internal", "ap2-aligned", "ap2-validated"]),
} as const;

export const MandateUnsignedSchema = z.object(MandateUnsignedShape).strict();

export const MandateSchema = z
  .object({
    ...MandateUnsignedShape,
    mandateHash: Sha256Schema,
    attestation: EdDsaAttestationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.notBefore) >= Date.parse(value.expiresAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be later than notBefore",
      });
    }
    if (Date.parse(value.issuedAt) > Date.parse(value.notBefore)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issuedAt"],
        message: "issuedAt must not be later than notBefore",
      });
    }
    if (BigInt(value.perTransactionLimitBaseUnits) > BigInt(value.incidentLimitBaseUnits)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["perTransactionLimitBaseUnits"],
        message: "Per-transaction limit must not exceed incident limit",
      });
    }
    if (BigInt(value.incidentLimitBaseUnits) > BigInt(value.dailyLimitBaseUnits)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["incidentLimitBaseUnits"],
        message: "Incident limit must not exceed daily limit",
      });
    }
  });

export type MandateUnsigned = z.infer<typeof MandateUnsignedSchema>;
export type Mandate = z.infer<typeof MandateSchema>;

export function computeMandateHash(value: Mandate | MandateUnsigned): `sha256:${string}` {
  const unsigned = "mandateHash" in value
    ? omitKeys(value, ["mandateHash", "attestation"] as const)
    : value;
  return canonicalHash(MandateUnsignedSchema.parse(unsigned));
}

const ExecutionPolicyUnsignedShape = {
  id: IdentifierSchema,
  version: z.number().int().positive(),
  network: NetworkIdentitySchema,
  assetMint: Base58Schema,
  assetDecimals: z.literal(6),
  executorPublicKey: Base58Schema,
  feePayer: Base58Schema,
  maxNetworkFeeLamports: PositiveBaseUnitsSchema,
  allowedProgramIds: z.array(Base58Schema).min(1).max(64),
  allowedAccountRules: z.array(Base58Schema).min(1).max(256),
  allowedFacilitatorOrigins: z.array(HttpsUrlSchema).min(1).max(32),
  maxResponseBytes: z.number().int().positive().max(16 * 1024 * 1024),
} as const;

export const ExecutionPolicyUnsignedSchema = z.object(ExecutionPolicyUnsignedShape).strict();
export const ExecutionPolicySchema = z
  .object({
    ...ExecutionPolicyUnsignedShape,
    policyHash: Sha256Schema,
  })
  .strict();

export type ExecutionPolicyUnsigned = z.infer<typeof ExecutionPolicyUnsignedSchema>;
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

export function computeExecutionPolicyHash(
  value: ExecutionPolicy | ExecutionPolicyUnsigned,
): `sha256:${string}` {
  const unsigned = "policyHash" in value ? omitKeys(value, ["policyHash"] as const) : value;
  return canonicalHash(ExecutionPolicyUnsignedSchema.parse(unsigned));
}

export const SanitizedTelemetrySchema = z
  .object({
    errorClass: z.string().min(1).max(128),
    statusCode: z.number().int().min(100).max(599).optional(),
    latencyMs: z.number().finite().nonnegative().max(3_600_000).optional(),
    failureRate: z.number().finite().min(0).max(1).optional(),
    redactedMessage: z.string().max(1_000).optional(),
  })
  .strict();

export const IncidentSchema = z
  .object({
    id: IdentifierSchema,
    service: z.string().min(1).max(256),
    signal: z.string().min(1).max(256),
    observedAt: TimestampSchema,
    healthBefore: z.enum(["healthy", "degraded", "down"]),
    sanitizedTelemetry: SanitizedTelemetrySchema,
    redactionReportHash: Sha256Schema,
  })
  .strict();

export type Incident = z.infer<typeof IncidentSchema>;

/**
 * Untrusted, non-authoritative ranking hints returned beside a signed offer.
 * These fields are intentionally outside the signed commercial envelope.
 */
export const VendorOfferEvaluationSchema = z
  .object({
    offerId: IdentifierSchema,
    latencyMs: z.number().finite().nonnegative().max(3_600_000).optional(),
    health: z.string().min(1).max(128).optional(),
    description: z.string().min(1).max(2_000),
  })
  .strict();

const VendorOfferPayloadShape = {
  offerId: IdentifierSchema,
  providerAgentId: IdentifierSchema,
  providerAgentCardUrl: HttpsUrlSchema,
  providerAgentCardHash: Sha256Schema,
  resourceUrl: HttpsUrlSchema,
  network: SolanaNetworkIdSchema,
  asset: z.literal("USDC"),
  assetMint: Base58Schema,
  amountBaseUnits: PositiveBaseUnitsSchema,
  payee: Base58Schema,
  expiresAt: TimestampSchema,
  capability: IdentifierSchema.optional(),
  method: z.enum(["GET", "POST"]).optional(),
} as const;

/** Normative payment-evidence-v2 offer payload, signed without projection. */
export const VendorOfferPayloadSchema = z.object(VendorOfferPayloadShape).strict();
export const VendorOfferSchema = SignedEnvelopeSchema(VendorOfferPayloadSchema).superRefine(
  (value, context) => {
    if (value.signer === value.payload.payee) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signer"],
        message: "Offer signer must be separate from the payment recipient",
      });
    }
  },
);

export type VendorOfferPayload = z.infer<typeof VendorOfferPayloadSchema>;
export type VendorOffer = z.infer<typeof VendorOfferSchema>;
export type VendorOfferEvaluation = z.infer<typeof VendorOfferEvaluationSchema>;

export const VendorOfferCatalogSchema = z
  .object({
    schemaVersion: z.literal("2"),
    offers: z.tuple([VendorOfferSchema, VendorOfferSchema]),
    offerEvaluations: z.tuple([
      VendorOfferEvaluationSchema,
      VendorOfferEvaluationSchema,
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const offerIds = value.offers.map((offer) => offer.payload.offerId);
    const evaluationIds = value.offerEvaluations.map((entry) => entry.offerId);
    if (new Set(offerIds).size !== 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["offers"],
        message: "Signed offer IDs must be distinct",
      });
    }
    if (
      new Set(evaluationIds).size !== 2 ||
      evaluationIds.some((offerId) => !offerIds.includes(offerId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["offerEvaluations"],
        message: "Offer evaluations must map one-to-one to signed offers",
      });
    }
  });

export type VendorOfferCatalog = z.infer<typeof VendorOfferCatalogSchema>;

/** Canonical hash of the exact payload authenticated by `VendorOffer.signature`. */
export function computeVendorOfferHash(value: VendorOffer | VendorOfferPayload): `sha256:${string}` {
  const payload = "payload" in value ? value.payload : value;
  return canonicalHash(VendorOfferPayloadSchema.parse(payload));
}

export const RecoveryDecisionSchema = z
  .object({
    diagnosis: z.string().min(1).max(2_000),
    requiredCapability: IdentifierSchema,
    selectedOfferId: IdentifierSchema,
    rejectedOfferIds: z.array(IdentifierSchema).min(1).max(63),
    evidenceRefs: z.array(z.string().min(1).max(256)).min(1).max(64),
    rationale: z.string().min(1).max(2_000),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.rejectedOfferIds.includes(value.selectedOfferId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rejectedOfferIds"],
        message: "Selected offer cannot also be rejected",
      });
    }
    if (new Set(value.rejectedOfferIds).size !== value.rejectedOfferIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rejectedOfferIds"],
        message: "Rejected offer IDs must be unique",
      });
    }
  });

export type RecoveryDecision = z.infer<typeof RecoveryDecisionSchema>;

export const PaymentProposalSchema = z
  .object({
    incidentId: IdentifierSchema,
    mandateId: IdentifierSchema,
    offerId: IdentifierSchema,
    operationId: IdentifierSchema,
    executionPolicyHash: Sha256Schema,
    network: NetworkIdentitySchema,
    method: z.enum(["GET", "POST"]),
    resourceUrl: HttpsUrlSchema,
    canonicalBodyHash: Sha256Schema,
    requestFingerprint: Sha256Schema,
    recipient: Base58Schema,
    assetMint: Base58Schema,
    amountBaseUnits: PositiveBaseUnitsSchema,
    challengeHash: Sha256Schema,
    paymentId: IdentifierSchema,
    nonce: IdentifierSchema,
    expiresAt: TimestampSchema,
    idempotencyKey: IdentifierSchema,
  })
  .strict();

export type PaymentProposal = z.infer<typeof PaymentProposalSchema>;

export const RequestFingerprintInputSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    resourceUrl: HttpsUrlSchema,
    operationId: IdentifierSchema,
    canonicalBodyHash: Sha256Schema,
    paymentId: IdentifierSchema,
    scheme: z.literal("exact"),
    network: SolanaNetworkIdSchema,
    assetMint: Base58Schema,
    amountBaseUnits: PositiveBaseUnitsSchema,
    payee: Base58Schema,
  })
  .strict();

export type RequestFingerprintInput = z.infer<typeof RequestFingerprintInputSchema>;

/** Public, non-telemetry identifier shared by live execution and promoted evidence. */
export const IncidentRunBindingInputSchema = z
  .object({
    incidentId: IdentifierSchema,
    mandateId: IdentifierSchema,
    operationId: IdentifierSchema,
    paymentId: IdentifierSchema,
    nonce: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
    executionPolicyHash: Sha256Schema,
  })
  .strict();

export type IncidentRunBindingInput = z.infer<typeof IncidentRunBindingInputSchema>;

export const FulfillmentReceiptPayloadSchema = z
  .object({
    version: z.literal("1"),
    issuerAgentId: IdentifierSchema,
    incidentId: IdentifierSchema,
    offerId: IdentifierSchema,
    paymentId: IdentifierSchema,
    executionPolicyHash: Sha256Schema,
    challengeHash: Sha256Schema,
    requestFingerprint: Sha256Schema,
    txSignature: Base58Schema,
    resourceResponseHash: Sha256Schema,
    resourceUrl: HttpsUrlSchema,
    payer: Base58Schema,
    payee: Base58Schema,
    assetMint: Base58Schema,
    amountBaseUnits: PositiveBaseUnitsSchema,
    fulfilledAt: TimestampSchema,
  })
  .strict();

export const RecoveryOutcomePayloadSchema = z
  .object({
    incidentId: IdentifierSchema,
    paymentId: IdentifierSchema,
    fulfillmentReceiptHash: Sha256Schema,
    resourceResponseHash: Sha256Schema,
    statusBefore: z.enum(["degraded", "down"]),
    statusAfter: z.literal("healthy"),
    healthProbeHash: Sha256Schema,
    recoveredAt: TimestampSchema,
  })
  .strict();

export const FulfillmentReceiptSchema = SignedEnvelopeSchema(FulfillmentReceiptPayloadSchema).superRefine(
  (value, context) => {
    if (value.signer === value.payload.payee) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signer"],
        message: "Receipt signer must be separate from the payment recipient",
      });
    }
  },
);

const RecoveryOutcomeEnvelopeSchema = SignedEnvelopeSchema(RecoveryOutcomePayloadSchema);
export const RecoveryOutcomeEventSchema = RecoveryOutcomeEnvelopeSchema.extend({
  artifactPath: z.string().min(1).max(512),
  artifactSha256: Sha256Schema,
}).strict();

export type FulfillmentReceiptPayload = z.infer<typeof FulfillmentReceiptPayloadSchema>;
export type RecoveryOutcomePayload = z.infer<typeof RecoveryOutcomePayloadSchema>;
export type FulfillmentReceipt = z.infer<typeof FulfillmentReceiptSchema>;
export type RecoveryOutcomeEvent = z.infer<typeof RecoveryOutcomeEventSchema>;

export function computeSignedEnvelopeHash(envelope: unknown): `sha256:${string}` {
  return canonicalHash(envelope);
}
