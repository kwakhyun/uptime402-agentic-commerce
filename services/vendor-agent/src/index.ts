import {
  canonicalHash,
  canonicalize,
  computeVendorOfferHash,
  createRequestFingerprint,
  FulfillmentReceiptSchema,
  parseBoundedStrictJsonBytes,
  sha256Bytes,
  VendorOfferEvaluationSchema,
  VendorOfferSchema,
  type FulfillmentReceipt,
  type FulfillmentReceiptPayload,
  type JsonValue,
  type VendorOffer,
  type VendorOfferEvaluation,
} from "@uptime402/domain";
import type {
  VendorClaimRepository,
  VendorPaymentClaimRecord,
} from "@uptime402/persistence";
import {
  Role,
  type AgentCard,
  type Message,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
} from "@a2a-js/sdk/server/express";
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  isValidPaymentId,
} from "@x402/extensions/payment-identifier";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { decodeStrictPaymentSignatureHeader } from "@uptime402/payments";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
const MAX_VENDOR_JSON_BODY_BYTES = 64 * 1024;

function strictExternalJsonParser() {
  return express.json({
    limit: MAX_VENDOR_JSON_BODY_BYTES,
    strict: true,
    inflate: false,
    type: ["application/json", "application/*+json"],
    verify: (_request, _response, body) => {
      parseBoundedStrictJsonBytes(
        body,
        MAX_VENDOR_JSON_BODY_BYTES,
        "Vendor request body",
      );
    },
  });
}

const Base58PublicKeySchema = z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

const OfferDiscoveryRequestSchema = z
  .object({
    kind: z.literal("discover_offers"),
    incidentId: z.string().min(1).max(128),
    capability: z.string().min(1).max(128),
  })
  .strict();

const RecoveryRequestSchema = z
  .object({
    incidentId: z.string().min(1).max(128),
    offerId: z.string().min(1).max(128),
    operationId: z.string().min(1).max(128),
    paymentId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
    executionPolicyHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

const PaymentRequirementsSchema = z
  .object({
    scheme: z.literal("exact"),
    network: z.string().regex(/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/),
    asset: z.string().min(32).max(160),
    amount: z.string().regex(/^[1-9][0-9]*$/),
    payTo: z.string().min(32).max(160),
    maxTimeoutSeconds: z.number().int().positive().max(3_600),
    extra: z.record(z.string(), z.unknown()),
  })
  .strict();

const PaymentPayloadSchema = z
  .object({
    x402Version: z.literal(2),
    resource: z
      .object({
        url: z.string().url(),
        description: z.string().max(2_000).optional(),
        mimeType: z.string().max(256).optional(),
        serviceName: z.string().max(256).optional(),
        tags: z.array(z.string().max(128)).max(64).optional(),
        iconUrl: z.string().url().optional(),
      })
      .strict()
      .optional(),
    accepted: PaymentRequirementsSchema,
    payload: z.object({ transaction: z.string().min(1).max(256_000) }).catchall(z.unknown()),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type OfferPair = readonly [VendorOffer, VendorOffer];
export type OfferEvaluationPair = readonly [VendorOfferEvaluation, VendorOfferEvaluation];

export interface VendorOfferSignatureVerifier {
  verify(offer: VendorOffer): Promise<boolean>;
}

export type StatelessPaymentValidation =
  | { valid: true }
  | { valid: false; reason: string };

export type ConfirmedSettlement = {
  confirmed: boolean;
  response: SettleResponse;
};

/**
 * Real implementations wrap an x402 facilitator and an independent Solana
 * confirmation check. Test adapters must label themselves local-simulated.
 */
export interface VendorX402Gateway {
  readonly mode: "devnet" | "local-simulated";
  validateStateless(input: {
    paymentPayload: PaymentPayload;
    paymentRequirements: PaymentRequirements;
    rawPaymentSignatureHeader: string;
  }): Promise<StatelessPaymentValidation>;
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse>;
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<ConfirmedSettlement>;
}

export interface RecoveryResourceProvider {
  fulfill(input: {
    incidentId: string;
    offerId: string;
    operationId: string;
    paymentId: string;
    txSignature: string;
  }): Promise<{ contentType: "application/json"; body: JsonValue }>;
}

export interface VendorFulfillmentReceiptSigner {
  readonly signerPublicKey: string;
  readonly keyId: string;
  sign(payload: FulfillmentReceiptPayload): Promise<string>;
}

export type VendorAgentConfig = {
  agentId: string;
  agentName: string;
  agentDescription: string;
  agentOrigin: string;
  a2aPath?: string;
  vendorTenant: string;
  maxTimeoutSeconds: number;
  facilitatorOrigin: string;
  /**
   * Deterministically selected from the facilitator's live `/supported`
   * response and enhanced through @x402/svm's server scheme at startup.
   */
  facilitatorFeePayer: string;
  offers: OfferPair;
  offerEvaluations: OfferEvaluationPair;
};

export type VendorAgentDependencies = {
  config: VendorAgentConfig;
  claims: VendorClaimRepository;
  offerVerifier: VendorOfferSignatureVerifier;
  x402: VendorX402Gateway;
  recoveryResource: RecoveryResourceProvider;
  receiptSigner: VendorFulfillmentReceiptSigner;
  now?: () => string;
};

export type VendorAgentVerificationMethod = Readonly<{
  id: string;
  type: "Ed25519VerificationKey2020";
  controller: string;
  publicKeyBase58: string;
  purposes: readonly ["offer-signing", "fulfillment-receipt-signing"];
}>;

export type PublishedVendorAgentCard = AgentCard & Readonly<{
  verificationMethods: readonly [VendorAgentVerificationMethod];
}>;

export type VendorAgentCardConfig = Pick<
  VendorAgentConfig,
  "agentId" | "agentName" | "agentDescription" | "agentOrigin" | "a2aPath" | "vendorTenant"
>;

type RecoveryInput = z.infer<typeof RecoveryRequestSchema>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function validateAndFreezeOffers(offers: OfferPair, config: VendorAgentConfig): OfferPair {
  if (offers.length !== 2) throw new TypeError("P0 vendor requires exactly two offers");
  const parsed = offers.map((offer) => VendorOfferSchema.parse(structuredClone(offer))) as [VendorOffer, VendorOffer];
  if (parsed[0].payload.offerId === parsed[1].payload.offerId) throw new TypeError("Offer IDs must be distinct");
  for (const offer of parsed) {
    if (new URL(offer.payload.providerAgentCardUrl).origin !== config.agentOrigin) {
      throw new TypeError(`Offer provider origin is not pinned: ${offer.payload.offerId}`);
    }
  }
  return deepFreeze(parsed) as OfferPair;
}

function validateAndFreezeOfferEvaluations(
  evaluations: OfferEvaluationPair,
  offers: OfferPair,
): OfferEvaluationPair {
  const parsed = evaluations.map((value) =>
    VendorOfferEvaluationSchema.parse(structuredClone(value)),
  ) as [VendorOfferEvaluation, VendorOfferEvaluation];
  const offerIds = offers.map((offer) => offer.payload.offerId);
  if (
    new Set(parsed.map((value) => value.offerId)).size !== 2 ||
    parsed.some((value) => !offerIds.includes(value.offerId))
  ) {
    throw new TypeError("Offer evaluation metadata must map one-to-one to the signed offers");
  }
  return deepFreeze(parsed) as OfferEvaluationPair;
}

export function buildVendorAgentCard(
  config: VendorAgentCardConfig,
  verificationAuthority: Pick<VendorFulfillmentReceiptSigner, "signerPublicKey" | "keyId">,
): PublishedVendorAgentCard {
  const a2aPath = config.a2aPath ?? "/a2a";
  return {
    name: config.agentName,
    description: config.agentDescription,
    supportedInterfaces: [
      {
        url: new URL(a2aPath, config.agentOrigin).toString(),
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        tenant: config.vendorTenant,
      },
    ],
    provider: { organization: "Uptime402 owned vendor", url: config.agentOrigin },
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "discover-recovery-offers",
        name: "Discover immutable recovery offers",
        description: "Returns exactly two signed offers; descriptions remain untrusted vendor data.",
        tags: ["sre", "recovery", "signed-offer"],
        examples: ["Discover recovery offers for a sanitized incident."],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        securityRequirements: [],
      },
    ],
    signatures: [],
    verificationMethods: [
      {
        id: verificationAuthority.keyId,
        type: "Ed25519VerificationKey2020",
        controller: config.agentId,
        publicKeyBase58: verificationAuthority.signerPublicKey,
        purposes: ["offer-signing", "fulfillment-receipt-signing"],
      },
    ],
  };
}

function getDiscoveryInput(context: RequestContext): z.infer<typeof OfferDiscoveryRequestSchema> {
  const dataParts = context.userMessage.parts.filter((part) => part.content?.$case === "data");
  if (dataParts.length !== 1) throw new TypeError("A2A offer discovery requires one structured data part");
  return OfferDiscoveryRequestSchema.parse(dataParts[0]!.content!.value);
}

function createOfferAgentExecutor(
  offers: OfferPair,
  offerEvaluations: OfferEvaluationPair,
  verifier: VendorOfferSignatureVerifier,
): AgentExecutor {
  return {
    async execute(context: RequestContext, eventBus: ExecutionEventBus) {
      const input = getDiscoveryInput(context);
      if (offers.some((offer) => offer.payload.capability !== input.capability)) {
        throw new TypeError("The requested capability does not match the immutable catalog");
      }
      const verified = await Promise.all(offers.map((offer) => verifier.verify(offer)));
      if (verified.some((value) => !value)) throw new Error("A signed offer failed verification");
      const message: Message = {
        messageId: `offers-${input.incidentId}`,
        contextId: context.contextId,
        taskId: "",
        role: Role.ROLE_AGENT,
        parts: [
          {
            content: {
              $case: "data",
              value: {
                kind: "signed_offers",
                incidentId: input.incidentId,
                untrustedVendorDescriptions: true,
                offers: structuredClone(offers),
                offerEvaluations: structuredClone(offerEvaluations),
              },
            },
            metadata: { trust: "untrusted-vendor-data" },
            filename: "",
            mediaType: "application/json",
          },
        ],
        metadata: { offerCount: 2 },
        extensions: [],
        referenceTaskIds: [],
      };
      eventBus.publish(AgentEvent.message(message));
      eventBus.finished();
    },
    async cancelTask() {
      throw new Error("Offer discovery is immediate and cannot be canceled");
    },
  };
}

function offerForRequest(offers: OfferPair, input: RecoveryInput): VendorOffer | null {
  return offers.find((offer) => offer.payload.offerId === input.offerId) ?? null;
}

function buildPaymentRequirements(
  offer: VendorOffer,
  input: RecoveryInput,
  requestFingerprint: `sha256:${string}`,
  maxTimeoutSeconds: number,
  facilitatorFeePayer: string,
): PaymentRequirements {
  return PaymentRequirementsSchema.parse({
    scheme: "exact",
    network: offer.payload.network,
    asset: offer.payload.assetMint,
    amount: offer.payload.amountBaseUnits,
    payTo: offer.payload.payee,
    maxTimeoutSeconds,
    extra: {
      feePayer: Base58PublicKeySchema.parse(facilitatorFeePayer),
      memo: input.paymentId,
      paymentId: input.paymentId,
      offerId: offer.payload.offerId,
      offerHash: computeVendorOfferHash(offer),
      requestFingerprint,
      executionPolicyHash: input.executionPolicyHash,
    },
  }) as PaymentRequirements;
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function buildChallenge(
  config: VendorAgentConfig,
  offer: VendorOffer,
  input: RecoveryInput,
): {
  paymentRequired: PaymentRequired;
  requestFingerprint: `sha256:${string}`;
  canonicalBodyHash: `sha256:${string}`;
  challengeHash: `sha256:${string}`;
} {
  if (!offer.payload.method) {
    throw new TypeError("Recovery offer must bind an HTTP method");
  }
  const canonicalBodyHash = canonicalHash(input);
  const requestFingerprint = createRequestFingerprint({
    method: offer.payload.method,
    resourceUrl: offer.payload.resourceUrl,
    operationId: input.operationId,
    canonicalBodyHash,
    paymentId: input.paymentId,
    scheme: "exact",
    network: offer.payload.network,
    assetMint: offer.payload.assetMint,
    amountBaseUnits: offer.payload.amountBaseUnits,
    payee: offer.payload.payee,
  });
  const requirements = buildPaymentRequirements(
    offer,
    input,
    requestFingerprint,
    config.maxTimeoutSeconds,
    config.facilitatorFeePayer,
  );
  requirements.extra = removeUndefined(requirements.extra);
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: offer.payload.resourceUrl,
      description: "Paid recovery routing resource",
      mimeType: "application/json",
      serviceName: config.agentName,
    },
    accepts: [requirements],
    extensions: {
      [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true),
    },
  };
  return {
    paymentRequired,
    requestFingerprint,
    canonicalBodyHash,
    challengeHash: canonicalHash(paymentRequired),
  };
}

function sameRequirements(left: PaymentRequirements, right: PaymentRequirements): boolean {
  return canonicalHash(left) === canonicalHash(right);
}

function parsePaymentPayload(header: string): PaymentPayload {
  return PaymentPayloadSchema.parse(decodeStrictPaymentSignatureHeader(header)) as PaymentPayload;
}

function validatePaymentBinding(
  paymentPayload: PaymentPayload,
  challenge: ReturnType<typeof buildChallenge>,
  input: RecoveryInput,
): string | null {
  const requirements = challenge.paymentRequired.accepts[0]!;
  if (!sameRequirements(paymentPayload.accepted, requirements)) return "payment_requirements_mismatch";
  if (extractPaymentIdentifier(paymentPayload) !== input.paymentId) return "payment_identifier_mismatch";
  if (!isValidPaymentId(input.paymentId)) return "payment_identifier_invalid";
  if (paymentPayload.resource && paymentPayload.resource.url !== challenge.paymentRequired.resource.url) {
    return "payment_resource_mismatch";
  }
  return null;
}

function paymentResponseForClaim(
  claim: VendorPaymentClaimRecord,
  receipt: FulfillmentReceipt,
  paymentRequirements: PaymentRequirements,
): SettleResponse {
  return {
    success: true,
    payer: receipt.payload.payer,
    transaction: claim.txSignature!,
    network: paymentRequirements.network,
    amount: receipt.payload.amountBaseUnits,
  };
}

function sendPersistedClaim(
  response: Response,
  claim: VendorPaymentClaimRecord,
  paymentRequirements: PaymentRequirements,
): void {
  if (!claim.resourceBodyBase64 || !claim.fulfillmentReceipt || !claim.txSignature) {
    response.status(503).json({ error: "reconcile_required", transactionCreated: false });
    return;
  }
  const receipt = FulfillmentReceiptSchema.parse(claim.fulfillmentReceipt);
  const paymentResponse = paymentResponseForClaim(claim, receipt, paymentRequirements);
  response.set(PAYMENT_RESPONSE_HEADER, encodePaymentResponseHeader(paymentResponse));
  response.status(200).json({
    resource: JSON.parse(Buffer.from(claim.resourceBodyBase64, "base64").toString("utf8")),
    fulfillmentReceipt: receipt,
    protocol: "x402",
    replayedFulfillment: true,
  });
}

async function processPaidRecovery(
  deps: VendorAgentDependencies,
  offers: OfferPair,
  input: RecoveryInput,
  rawPaymentSignatureHeader: string,
  response: Response,
): Promise<void> {
  const offer = offerForRequest(offers, input)!;
  const challenge = buildChallenge(deps.config, offer, input);
  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = parsePaymentPayload(rawPaymentSignatureHeader);
  } catch {
    response.status(400).json({ error: "payment_signature_malformed" });
    return;
  }
  const bindingError = validatePaymentBinding(paymentPayload, challenge, input);
  if (bindingError) {
    response.status(400).json({ error: bindingError });
    return;
  }
  if (!(await deps.offerVerifier.verify(offer))) {
    response.status(400).json({ error: "signed_offer_invalid" });
    return;
  }
  const paymentRequirements = challenge.paymentRequired.accepts[0]!;
  const stateless = await deps.x402.validateStateless({
    paymentPayload,
    paymentRequirements,
    rawPaymentSignatureHeader,
  });
  if (!stateless.valid) {
    response.status(400).json({ error: "payment_signature_invalid", reason: stateless.reason });
    return;
  }

  const claim = await deps.claims.claimVendorPayment({
    vendorTenant: deps.config.vendorTenant,
    paymentId: input.paymentId,
    requestFingerprint: challenge.requestFingerprint,
    occurredAt: (deps.now ?? (() => new Date().toISOString()))(),
  });
  if (claim.kind === "conflict") {
    response.status(409).json({ error: "payment_identifier_fingerprint_conflict" });
    return;
  }
  if (claim.kind === "persisted") {
    sendPersistedClaim(response, claim.record, paymentRequirements);
    return;
  }
  if (claim.kind === "reconcile_required") {
    response.status(503).json({
      error: "reconcile_required",
      reason: claim.reason,
      paymentId: input.paymentId,
      settlementRetried: false,
    });
    return;
  }

  let verification: VerifyResponse;
  try {
    verification = await deps.x402.verify(paymentPayload, paymentRequirements);
  } catch {
    await deps.claims.releaseVendorClaimBeforeSubmission(
      deps.config.vendorTenant,
      input.paymentId,
      claim.record.version,
    );
    response.status(502).json({ error: "facilitator_verify_unavailable", settlementAttempted: false });
    return;
  }
  if (!verification.isValid || !verification.payer) {
    await deps.claims.releaseVendorClaimBeforeSubmission(
      deps.config.vendorTenant,
      input.paymentId,
      claim.record.version,
    );
    response.status(402).json({ error: "payment_verification_failed", settlementAttempted: false });
    return;
  }

  const attempted = await deps.claims.markVendorSettlementAttempted(
    deps.config.vendorTenant,
    input.paymentId,
    claim.record.version,
    (deps.now ?? (() => new Date().toISOString()))(),
  );
  let settlement: ConfirmedSettlement;
  try {
    settlement = await deps.x402.settle(paymentPayload, paymentRequirements);
  } catch {
    response.status(502).json({
      error: "settlement_unknown_reconcile_required",
      paymentId: input.paymentId,
      settlementRetried: false,
    });
    return;
  }
  if (
    !settlement.response.success ||
    !settlement.confirmed ||
    !settlement.response.payer ||
    settlement.response.network !== paymentRequirements.network ||
    (settlement.response.amount !== undefined && settlement.response.amount !== paymentRequirements.amount)
  ) {
    response.status(502).json({
      error: "settlement_not_confirmed_reconcile_required",
      paymentId: input.paymentId,
      settlementRetried: false,
    });
    return;
  }

  const now = deps.now ?? (() => new Date().toISOString());
  const settled = await deps.claims.transitionVendorPaymentClaim(
    deps.config.vendorTenant,
    input.paymentId,
    "settling",
    attempted.version,
    "settlement_verified",
    now(),
    { txSignature: settlement.response.transaction },
  );
  const resource = await deps.recoveryResource.fulfill({
    ...input,
    txSignature: settlement.response.transaction,
  });
  const resourceBytes = Buffer.from(canonicalize(resource.body), "utf8");
  const resourceResponseHash = sha256Bytes(resourceBytes);
  const generated = await deps.claims.transitionVendorPaymentClaim(
    deps.config.vendorTenant,
    input.paymentId,
    "settlement_verified",
    settled.version,
    "resource_generated",
    now(),
    {
      resourceResponseHash,
      resourceContentType: resource.contentType,
      resourceBodyBase64: resourceBytes.toString("base64"),
    },
  );
  const receiptPayload: FulfillmentReceiptPayload = {
    version: "1",
    issuerAgentId: deps.config.agentId,
    incidentId: input.incidentId,
    offerId: offer.payload.offerId,
    paymentId: input.paymentId,
    executionPolicyHash: input.executionPolicyHash,
    challengeHash: challenge.challengeHash,
    requestFingerprint: challenge.requestFingerprint,
    txSignature: settlement.response.transaction,
    resourceResponseHash,
    resourceUrl: offer.payload.resourceUrl,
    payer: settlement.response.payer,
    payee: offer.payload.payee,
    assetMint: offer.payload.assetMint,
    amountBaseUnits: offer.payload.amountBaseUnits,
    fulfilledAt: now(),
  };
  const receipt: FulfillmentReceipt = FulfillmentReceiptSchema.parse({
    payload: receiptPayload,
    signer: deps.receiptSigner.signerPublicKey,
    keyId: deps.receiptSigner.keyId,
    signature: await deps.receiptSigner.sign(receiptPayload),
  });
  const completed = await deps.claims.transitionVendorPaymentClaim(
    deps.config.vendorTenant,
    input.paymentId,
    "resource_generated",
    generated.version,
    "receipt_signed",
    now(),
    { fulfillmentReceipt: receipt as unknown as JsonValue },
  );
  response.set(PAYMENT_RESPONSE_HEADER, encodePaymentResponseHeader(settlement.response));
  response.status(200).json({
    resource: JSON.parse(Buffer.from(completed.resourceBodyBase64!, "base64").toString("utf8")),
    fulfillmentReceipt: receipt,
    protocol: "x402",
    replayedFulfillment: false,
  });
}

export function createVendorAgentApp(deps: VendorAgentDependencies): Express {
  const offers = validateAndFreezeOffers(deps.config.offers, deps.config);
  const offerEvaluations = validateAndFreezeOfferEvaluations(deps.config.offerEvaluations, offers);
  if (offers.some((offer) => deps.receiptSigner.signerPublicKey === offer.payload.payee)) {
    throw new TypeError("Receipt-signing identity must be separate from the USDC recipient");
  }
  if (offers.some((offer) => offer.keyId !== deps.receiptSigner.keyId || offer.signer !== deps.receiptSigner.signerPublicKey)) {
    throw new TypeError("Offers and receipts must use the same pinned vendor authority");
  }
  const agentCard = buildVendorAgentCard(deps.config, deps.receiptSigner);
  const executor = createOfferAgentExecutor(offers, offerEvaluations, deps.offerVerifier);
  const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), executor);
  const app = express();
  const a2aPath = deps.config.a2aPath ?? "/a2a";

  app.disable("x-powered-by");
  // This parser runs before the A2A SDK's parser as well as the x402 resource
  // route, so duplicate keys and malformed UTF-8 are rejected at the raw-byte
  // boundary instead of after SDK/schema normalization.
  app.use(strictExternalJsonParser());
  app.get("/healthz", (_request: Request, response: Response) => {
    response.json({
      status: "ok",
      role: "vendor-agent",
      agentId: deps.config.agentId,
      signerMaterialExposed: false,
    });
  });
  // Cloud Run reserves /healthz on its public ingress in some revisions. Keep
  // a semantically identical public health endpoint for deployment evidence.
  app.get("/health", (_request: Request, response: Response) => {
    response.status(200).json({ status: "healthy" });
  });
  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 60 } }),
  );
  app.use(
    a2aPath,
    jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
  );
  app.post(
    "/v1/recovery",
    async (request: Request, response: Response) => {
      const parsed = RecoveryRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid_recovery_request", details: parsed.error.issues });
        return;
      }
      const offer = offerForRequest(offers, parsed.data);
      if (!offer || offer.payload.method !== "POST" || offer.payload.resourceUrl !== new URL("/v1/recovery", deps.config.agentOrigin).toString()) {
        response.status(404).json({ error: "immutable_offer_not_found" });
        return;
      }
      if (Date.parse(offer.payload.expiresAt) <= Date.parse((deps.now ?? (() => new Date().toISOString()))())) {
        response.status(410).json({ error: "offer_expired" });
        return;
      }
      const paymentSignature = request.header(PAYMENT_SIGNATURE_HEADER);
      if (!paymentSignature) {
        if (!(await deps.offerVerifier.verify(offer))) {
          response.status(500).json({ error: "signed_offer_invalid" });
          return;
        }
        const challenge = buildChallenge(deps.config, offer, parsed.data);
        response.set(PAYMENT_REQUIRED_HEADER, encodePaymentRequiredHeader(challenge.paymentRequired));
        response.status(402).json({
          error: "payment_required",
          protocol: "x402",
          paymentId: parsed.data.paymentId,
          challengeHash: challenge.challengeHash,
          requestFingerprint: challenge.requestFingerprint,
          canonicalBodyHash: challenge.canonicalBodyHash,
          facilitatorOrigin: deps.config.facilitatorOrigin,
          paymentCreated: false,
        });
        return;
      }
      await processPaidRecovery(deps, offers, parsed.data, paymentSignature, response);
    },
  );

  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(400).json({ error: "invalid_json" });
  });
  return app;
}
