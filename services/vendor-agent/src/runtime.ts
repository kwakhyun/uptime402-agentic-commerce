import { constants as fsConstants } from "node:fs";
import type { Server } from "node:http";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  FulfillmentReceiptPayloadSchema,
  VendorOfferCatalogSchema,
  VendorOfferPayloadSchema,
  canonicalHash,
  normalizePinnedOrigin,
  parseStrictJson,
  type FulfillmentReceiptPayload,
  type JsonValue,
  type VendorOffer,
  type VendorOfferEvaluation,
} from "@uptime402/domain";
import {
  createFirestoreTransactionalRepository,
  type FirestoreTransactionalRepository,
} from "@uptime402/persistence";
import {
  PinnedFacilitatorClient,
  assertOfficialDevnetGenesis,
  decodeStrictPaymentSignatureHeader,
  loadCloudRunSecretKeypairSigner,
  signEnvelope,
  validateExactSvmPayerSignature,
  verifyCanonicalEd25519Signature,
  verifySolanaSettlement,
  type JsonRpcOptions,
  type SupportedResponse,
} from "@uptime402/payments";
import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { ExactSvmScheme as ExactSvmServerScheme } from "@x402/svm/exact/server";
import { address } from "@solana/kit";
import type { Express } from "express";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";

import {
  buildVendorAgentCard,
  createVendorAgentApp,
  type ConfirmedSettlement,
  type OfferPair,
  type OfferEvaluationPair,
  type RecoveryResourceProvider,
  type VendorFulfillmentReceiptSigner,
  type VendorIamTokenVerifier,
  type VendorOfferSignatureVerifier,
  type VendorX402Gateway,
} from "./index.js";

const MAX_CATALOG_BYTES = 256 * 1024;
const Base58PublicKeySchema = z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

export type VerifiedOfferCatalog = Readonly<{
  offers: OfferPair;
  offerEvaluations: OfferEvaluationPair;
}>;

const RecoveryResourceSchema = z
  .object({
    version: z.literal("1"),
    kind: z.literal("firestore_recovery_route"),
    activationId: z.string().min(1).max(128),
    incidentId: z.string().min(1).max(128),
    offerId: z.string().min(1).max(128),
    operationId: z.string().min(1).max(128),
    paymentId: z.string().min(1).max(128),
    txSignature: z.string().min(64).max(96).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),
    resourceUrl: z.string().url(),
    state: z.literal("active"),
    activatedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const StoredEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("1"),
    recordHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    value: RecoveryResourceSchema,
  })
  .strict();

export type VendorAgentRuntimeConfig = Readonly<{
  host: string;
  port: number;
  firestoreProjectId: string;
  firestoreDatabaseId: string;
  firestoreCollectionPrefix: string;
  agentId: string;
  agentName: string;
  agentDescription: string;
  agentOrigin: string;
  vendorTenant: string;
  offerCatalogPath: string;
  offerCatalogRoot: string;
  offerSignerPublicKey: string;
  offerSignerKeyId: string;
  receiptKeyPath: string;
  receiptSecretRoot: string;
  receiptPublicKey: string;
  receiptKeyId: string;
  usdcRecipient: string;
  expectedPayerPublicKey: string;
  reconciliationAudience: string;
  allowedReconciliationPrincipal: string;
  solanaRpcUrl: string;
  facilitatorUrl: string;
  facilitatorOrigin: string;
  facilitatorFeePayer: string;
  maxTimeoutSeconds: number;
  settlementConfirmationAttempts: number;
  settlementConfirmationDelayMs: number;
}>;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("PORT must be an integer from 1 through 65535");
  }
  return parsed;
}

function parseBoundedInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function parseAbsolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  return resolve(value);
}

function parseSolanaPublicKey(value: string, name: string): string {
  const parsed = Base58PublicKeySchema.parse(value);
  try {
    address(parsed);
  } catch {
    throw new TypeError(`${name} must be a canonical 32-byte Solana address`);
  }
  return parsed;
}

function parseHttpsUrl(value: string, name: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new TypeError(`${name} must be an HTTPS URL without credentials or a fragment`);
  }
  return parsed.toString();
}

function assertDevnetEnvironment(env: NodeJS.ProcessEnv): void {
  const expected: Readonly<Record<string, string>> = {
    SOLANA_CLUSTER_LABEL: "devnet",
    SOLANA_GENESIS_HASH: DEVNET_GENESIS_HASH,
    X402_NETWORK_ID: DEVNET_X402_NETWORK_ID,
    X402_SDK_NETWORK_ID: DEVNET_X402_NETWORK_ID,
    USDC_MINT: DEVNET_USDC_MINT,
    USDC_DECIMALS: "6",
  };
  for (const [name, pinned] of Object.entries(expected)) {
    if (required(env, name) !== pinned) throw new Error(`${name} must equal the pinned Devnet value`);
  }
  if (env.FIRESTORE_EMULATOR_HOST?.trim()) {
    throw new Error("Production vendor agent refuses FIRESTORE_EMULATOR_HOST");
  }
}

export function parseVendorAgentRuntimeConfig(env: NodeJS.ProcessEnv): VendorAgentRuntimeConfig {
  assertDevnetEnvironment(env);
  const agentOrigin = normalizePinnedOrigin(required(env, "PUBLIC_VENDOR_ORIGIN"));
  const reconciliationAudience = normalizePinnedOrigin(
    required(env, "VENDOR_RECONCILE_EXPECTED_AUDIENCE"),
  );
  if (reconciliationAudience !== agentOrigin) {
    throw new Error("Vendor reconciliation audience must equal the public vendor origin");
  }
  const allowedReconciliationPrincipal = required(
    env,
    "VENDOR_RECONCILE_CONTROL_PLANE_PRINCIPAL",
  );
  if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(allowedReconciliationPrincipal)) {
    throw new TypeError("VENDOR_RECONCILE_CONTROL_PLANE_PRINCIPAL must be a service account email");
  }
  const facilitatorUrl = parseHttpsUrl(required(env, "X402_FACILITATOR_URL"), "X402_FACILITATOR_URL");
  const collectionPrefix = required(env, "FIRESTORE_COLLECTION_PREFIX");
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(collectionPrefix)) {
    throw new TypeError("FIRESTORE_COLLECTION_PREFIX is invalid");
  }
  const receiptKeyId = required(env, "VENDOR_RECEIPT_KEY_ID");
  const offerSignerKeyId = required(env, "VENDOR_OFFER_SIGNER_KEY_ID");
  const offerSignerPublicKey = parseSolanaPublicKey(
    required(env, "VENDOR_OFFER_SIGNER_PUBLIC_KEY"),
    "VENDOR_OFFER_SIGNER_PUBLIC_KEY",
  );
  const receiptPublicKey = parseSolanaPublicKey(
    required(env, "VENDOR_RECEIPT_PUBLIC_KEY"),
    "VENDOR_RECEIPT_PUBLIC_KEY",
  );
  if (receiptKeyId !== offerSignerKeyId || receiptPublicKey !== offerSignerPublicKey) {
    throw new Error(
      "Signed offers and fulfillment receipts must use the same pinned vendor Agent Card authority",
    );
  }
  const usdcRecipient = parseSolanaPublicKey(
    required(env, "VENDOR_USDC_RECIPIENT"),
    "VENDOR_USDC_RECIPIENT",
  );
  const expectedPayerPublicKey = parseSolanaPublicKey(
    required(env, "VENDOR_EXPECTED_PAYER_PUBLIC_KEY"),
    "VENDOR_EXPECTED_PAYER_PUBLIC_KEY",
  );
  if (
    expectedPayerPublicKey === usdcRecipient ||
    expectedPayerPublicKey === receiptPublicKey
  ) {
    throw new Error("Expected payer, USDC recipient, and vendor authority must be distinct");
  }
  return Object.freeze({
    host: env.HOST?.trim() || "0.0.0.0",
    port: parsePort(required(env, "PORT")),
    firestoreProjectId: required(env, "FIRESTORE_PROJECT_ID"),
    firestoreDatabaseId: env.FIRESTORE_DATABASE_ID?.trim() || "(default)",
    firestoreCollectionPrefix: collectionPrefix,
    agentId: required(env, "VENDOR_AGENT_ID"),
    agentName: required(env, "VENDOR_AGENT_NAME"),
    agentDescription:
      env.VENDOR_AGENT_DESCRIPTION?.trim() || "Uptime402 owned vendor for paid recovery resources.",
    agentOrigin,
    vendorTenant: required(env, "VENDOR_TENANT"),
    offerCatalogPath: parseAbsolutePath(
      required(env, "VENDOR_OFFER_CATALOG_PATH"),
      "VENDOR_OFFER_CATALOG_PATH",
    ),
    offerCatalogRoot: parseAbsolutePath(
      required(env, "VENDOR_OFFER_CATALOG_ROOT"),
      "VENDOR_OFFER_CATALOG_ROOT",
    ),
    offerSignerPublicKey,
    offerSignerKeyId,
    receiptKeyPath: parseAbsolutePath(
      required(env, "VENDOR_RECEIPT_KEY_PATH"),
      "VENDOR_RECEIPT_KEY_PATH",
    ),
    receiptSecretRoot: parseAbsolutePath(
      required(env, "VENDOR_RECEIPT_SECRET_ROOT"),
      "VENDOR_RECEIPT_SECRET_ROOT",
    ),
    receiptPublicKey,
    receiptKeyId,
    usdcRecipient,
    expectedPayerPublicKey,
    reconciliationAudience,
    allowedReconciliationPrincipal,
    solanaRpcUrl: parseHttpsUrl(required(env, "SOLANA_RPC_URL"), "SOLANA_RPC_URL"),
    facilitatorUrl,
    facilitatorOrigin: normalizePinnedOrigin(new URL(facilitatorUrl).origin),
    facilitatorFeePayer: parseSolanaPublicKey(
      required(env, "X402_FACILITATOR_FEE_PAYER"),
      "X402_FACILITATOR_FEE_PAYER",
    ),
    maxTimeoutSeconds: parseBoundedInteger(
      required(env, "X402_MAX_TIMEOUT_SECONDS"),
      "X402_MAX_TIMEOUT_SECONDS",
      1,
      3_600,
    ),
    settlementConfirmationAttempts: parseBoundedInteger(
      env.SETTLEMENT_CONFIRMATION_ATTEMPTS?.trim() || "5",
      "SETTLEMENT_CONFIRMATION_ATTEMPTS",
      1,
      20,
    ),
    settlementConfirmationDelayMs: parseBoundedInteger(
      env.SETTLEMENT_CONFIRMATION_DELAY_MS?.trim() || "1000",
      "SETTLEMENT_CONFIRMATION_DELAY_MS",
      50,
      10_000,
    ),
  });
}

function isInsideRoot(candidate: string, root: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

/**
 * Cloud Run secret volumes may expose a stable filename through an in-mount
 * symlink chain. Resolve that chain, require both its directory entry and final
 * target to stay under the dedicated mount root, then open the resolved target
 * with no-follow semantics so an external target or replacement symlink at the
 * resolved leaf cannot be treated as the catalog.
 */
async function readBoundedJsonFile(path: string, allowedRoot: string): Promise<unknown> {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(allowedRoot);
  const [resolvedRoot, resolvedConfiguredParent, resolvedPath] = await Promise.all([
    realpath(normalizedRoot).catch(() => {
      throw new Error("Unable to resolve the configured offer catalog root");
    }),
    realpath(dirname(normalizedPath)).catch(() => {
      throw new Error("Unable to resolve the configured offer catalog parent");
    }),
    realpath(normalizedPath).catch(() => {
      throw new Error("Unable to resolve the configured offer catalog");
    }),
  ]);
  if (!isInsideRoot(resolvedConfiguredParent, resolvedRoot)) {
    throw new Error("Offer catalog path is outside the configured catalog root");
  }
  if (!isInsideRoot(resolvedPath, resolvedRoot)) {
    throw new Error("Offer catalog resolves outside the configured catalog root");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(resolvedPath, fsConstants.O_RDONLY | noFollow).catch(() => {
    throw new Error("Unable to open the configured offer catalog");
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CATALOG_BYTES) {
      throw new Error("Offer catalog must be a non-empty regular file no larger than 256 KiB");
    }
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, stat.size + 1, 0);
    if (bytesRead !== stat.size) {
      throw new Error("Offer catalog could not be read completely or changed while reading");
    }
    try {
      return parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)),
      );
    } catch {
      throw new TypeError("Offer catalog is not valid UTF-8 JSON");
    }
  } finally {
    await handle.close();
  }
}

export async function loadAndVerifyOfferCatalog(
  config: VendorAgentRuntimeConfig,
): Promise<VerifiedOfferCatalog> {
  const catalog = VendorOfferCatalogSchema.parse(
    await readBoundedJsonFile(config.offerCatalogPath, config.offerCatalogRoot),
  );
  const offers = catalog.offers as [VendorOffer, VendorOffer];
  const offerEvaluations = catalog.offerEvaluations as [VendorOfferEvaluation, VendorOfferEvaluation];
  if (offers[0].payload.offerId === offers[1].payload.offerId) throw new Error("Offer catalog IDs must be distinct");
  const expectedAgentCardUrl = new URL("/.well-known/agent-card.json", config.agentOrigin).toString();
  const expectedResourceUrl = new URL("/v1/recovery", config.agentOrigin).toString();
  for (const offer of offers) {
    if (
      offer.payload.providerAgentId !== config.agentId ||
      offer.payload.providerAgentCardUrl !== expectedAgentCardUrl ||
      offer.payload.resourceUrl !== expectedResourceUrl ||
      offer.payload.method !== "POST"
    ) {
      throw new Error(`Offer ${offer.payload.offerId} does not bind the pinned vendor identity/routes`);
    }
    if (
      offer.payload.network !== DEVNET_X402_NETWORK_ID ||
      offer.payload.asset !== "USDC" ||
      offer.payload.assetMint !== DEVNET_USDC_MINT ||
      offer.payload.payee !== config.usdcRecipient
    ) {
      throw new Error(`Offer ${offer.payload.offerId} does not bind the pinned Devnet USDC payment`);
    }
    if (Date.parse(offer.payload.expiresAt) <= Date.now()) {
      throw new Error(`Offer ${offer.payload.offerId} is expired`);
    }
    if (
      offer.keyId !== config.offerSignerKeyId ||
      offer.signer !== config.offerSignerPublicKey
    ) {
      throw new Error(`Offer ${offer.payload.offerId} has an unpinned signing authority`);
    }
    const verified = await verifyCanonicalEd25519Signature({
      payload: offer.payload,
      payloadSchema: VendorOfferPayloadSchema,
      signerPublicKey: config.offerSignerPublicKey,
      signature: offer.signature,
    });
    if (!verified) throw new Error(`Offer ${offer.payload.offerId} signature verification failed`);
  }
  if (!offers[0].payload.capability || offers[0].payload.capability !== offers[1].payload.capability) {
    throw new Error("P0 offer catalog entries must compete for the same capability");
  }
  const ids = offers.map((offer) => offer.payload.offerId);
  if (
    new Set(offerEvaluations.map((entry) => entry.offerId)).size !== 2 ||
    offerEvaluations.some((entry) => !ids.includes(entry.offerId))
  ) {
    throw new Error("Offer evaluation metadata must map one-to-one to signed offers");
  }
  return Object.freeze({
    offers: Object.freeze([Object.freeze(offers[0]), Object.freeze(offers[1])]) as OfferPair,
    offerEvaluations: Object.freeze([
      Object.freeze(offerEvaluations[0]),
      Object.freeze(offerEvaluations[1]),
    ]) as OfferEvaluationPair,
  });
}

export async function verifyFacilitatorExactSvmSupport(
  supported: SupportedResponse,
  pinnedFeePayer: string,
): Promise<string> {
  const kinds = supported.kinds.filter(
    (kind) =>
      kind.x402Version === 2 &&
      kind.scheme === "exact" &&
      kind.network === DEVNET_X402_NETWORK_ID,
  );
  if (kinds.length !== 1) {
    throw new Error("Facilitator must advertise exactly one x402 v2 exact Solana Devnet kind");
  }
  // Current x402 facilitator responses advertise SVM signers at the CAIP
  // namespace wildcard (`solana:*`). Prefer an exact Devnet declaration when
  // present so a network-specific signer set cannot be widened by the fallback.
  const signers =
    supported.signers[DEVNET_X402_NETWORK_ID] ?? supported.signers["solana:*"];
  if (!signers || !signers.includes(pinnedFeePayer)) {
    throw new Error("Pinned facilitator fee payer is not advertised for Solana Devnet");
  }
  const kind = kinds[0]!;
  const advertisedFeePayer = kind.extra?.feePayer;
  if (typeof advertisedFeePayer !== "string" || !signers.includes(advertisedFeePayer)) {
    throw new Error("Facilitator exact SVM kind has a missing or mismatched fee payer");
  }
  const base: PaymentRequirements = {
    scheme: "exact",
    network: DEVNET_X402_NETWORK_ID,
    asset: DEVNET_USDC_MINT,
    amount: "1",
    payTo: pinnedFeePayer,
    maxTimeoutSeconds: 60,
    extra: {},
  };
  const enhanced = await new ExactSvmServerScheme().enhancePaymentRequirements(
    base,
    { ...kind, extra: { ...kind.extra, feePayer: pinnedFeePayer } },
    supported.extensions,
  );
  if (enhanced.extra?.feePayer !== pinnedFeePayer) {
    throw new Error("Official exact SVM requirement enhancement changed the pinned fee payer");
  }
  return pinnedFeePayer;
}

class CanonicalOfferVerifier implements VendorOfferSignatureVerifier {
  constructor(private readonly config: VendorAgentRuntimeConfig) {}

  async verify(offer: VendorOffer): Promise<boolean> {
    if (
      offer.keyId !== this.config.offerSignerKeyId ||
      offer.signer !== this.config.offerSignerPublicKey
    ) {
      return false;
    }
    return verifyCanonicalEd25519Signature({
      payload: offer.payload,
      payloadSchema: VendorOfferPayloadSchema,
      signerPublicKey: this.config.offerSignerPublicKey,
      signature: offer.signature,
    }).catch(() => false);
  }
}

class CanonicalReceiptSigner implements VendorFulfillmentReceiptSigner {
  readonly signerPublicKey: string;

  constructor(
    private readonly signer: Awaited<ReturnType<typeof loadCloudRunSecretKeypairSigner>>,
    readonly keyId: string,
  ) {
    this.signerPublicKey = signer.address;
  }

  async sign(payload: FulfillmentReceiptPayload): Promise<string> {
    return (
      await signEnvelope(payload, FulfillmentReceiptPayloadSchema, {
        signer: this.signer,
        keyId: this.keyId,
      })
    ).signature;
  }
}

class GoogleCloudVendorIamTokenVerifier implements VendorIamTokenVerifier {
  constructor(private readonly client = new OAuth2Client()) {}

  async verifyBearerToken(token: string, expectedAudience: string) {
    const ticket = await this.client.verifyIdToken({
      idToken: token,
      audience: expectedAudience,
    });
    const payload = ticket.getPayload();
    if (!payload || typeof payload.aud !== "string" || typeof payload.email !== "string") {
      throw new Error("Google ID token lacks an exact audience or service-account email");
    }
    return { audience: payload.aud, principal: payload.email };
  }
}

class FirestoreRecoveryResourceProvider implements RecoveryResourceProvider {
  constructor(
    private readonly repository: FirestoreTransactionalRepository,
    private readonly offers: OfferPair,
  ) {}

  async fulfill(input: {
    incidentId: string;
    offerId: string;
    operationId: string;
    paymentId: string;
    txSignature: string;
    requestedAt: string;
  }): Promise<{
    contentType: "application/json";
    body: JsonValue;
    fulfilledAt: string;
  }> {
    const offer = this.offers.find((candidate) => candidate.payload.offerId === input.offerId);
    if (!offer) throw new Error("Recovery resource references an unknown immutable offer");
    const activationBinding = {
      incidentId: input.incidentId,
      offerId: input.offerId,
      operationId: input.operationId,
      paymentId: input.paymentId,
      txSignature: input.txSignature,
    };
    const activationId = canonicalHash({
      namespace: "uptime402-recovery-route-v1",
      paymentId: input.paymentId,
      request: activationBinding,
    }).slice("sha256:".length);
    const value = RecoveryResourceSchema.parse({
      version: "1",
      kind: "firestore_recovery_route",
      activationId,
      ...activationBinding,
      resourceUrl: offer.payload.resourceUrl,
      state: "active",
      activatedAt: input.requestedAt,
      expiresAt: offer.payload.expiresAt,
    });
    const reference = this.repository.firestore
      .collection(`${this.repository.collectionPrefix}_recovery_resources`)
      .doc(activationId);
    const persisted = await this.repository.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists) {
        const existing = StoredEnvelopeSchema.parse(snapshot.data());
        if (canonicalHash(existing.value) !== existing.recordHash) {
          throw new Error("Recovery resource record integrity failure");
        }
        const existingBinding: Record<string, unknown> = { ...existing.value };
        const requestedBinding: Record<string, unknown> = { ...value };
        delete existingBinding.activatedAt;
        delete requestedBinding.activatedAt;
        if (canonicalHash(existingBinding) !== canonicalHash(requestedBinding)) {
          throw new Error("Recovery resource activation identity conflict");
        }
        return existing.value;
      }
      transaction.create(reference, {
        schemaVersion: "1",
        recordHash: canonicalHash(value),
        value,
      });
      return value;
    });
    return {
      contentType: "application/json",
      body: persisted as JsonValue,
      fulfilledAt: persisted.activatedAt,
    };
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class ProductionVendorX402Gateway implements VendorX402Gateway {
  readonly mode = "devnet" as const;

  constructor(
    private readonly facilitator: PinnedFacilitatorClient,
    private readonly rpc: JsonRpcOptions,
    private readonly feePayer: string,
    private readonly confirmationAttempts: number,
    private readonly confirmationDelayMs: number,
  ) {}

  async validateStateless(input: {
    paymentPayload: PaymentPayload;
    paymentRequirements: PaymentRequirements;
    rawPaymentSignatureHeader: string;
  }) {
    try {
      const strict = decodeStrictPaymentSignatureHeader(input.rawPaymentSignatureHeader);
      if (
        canonicalHash(strict) !== canonicalHash(input.paymentPayload) ||
        canonicalHash(strict.accepted) !== canonicalHash(input.paymentRequirements) ||
        strict.accepted.extra?.feePayer !== this.feePayer
      ) {
        return { valid: false, reason: "payment_payload_binding_mismatch" } as const;
      }
      await validateExactSvmPayerSignature(strict);
      return { valid: true } as const;
    } catch {
      return { valid: false, reason: "invalid_exact_svm_payer_signature" } as const;
    }
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const local = await validateExactSvmPayerSignature(paymentPayload);
    const verified = await this.facilitator.verify(paymentPayload, paymentRequirements);
    if (verified.isValid && verified.payer !== local.payer) {
      return {
        isValid: false,
        invalidReason: "facilitator_payer_mismatch",
        payer: local.payer,
      };
    }
    return verified;
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<ConfirmedSettlement> {
    const response = await this.facilitator.settle(paymentPayload, paymentRequirements);
    if (!response.success || !response.payer) return { confirmed: false, response };
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.confirmationAttempts; attempt += 1) {
      try {
        await verifySolanaSettlement({
          rpc: this.rpc,
          txSignature: response.transaction,
          payerOwner: response.payer,
          payeeOwner: paymentRequirements.payTo,
          amountBaseUnits: paymentRequirements.amount,
          assetMint: DEVNET_USDC_MINT,
        });
        return { confirmed: true, response };
      } catch (error) {
        lastError = error;
        if (attempt < this.confirmationAttempts) await delay(this.confirmationDelayMs);
      }
    }
    void lastError;
    return { confirmed: false, response };
  }
}

export type VendorAgentRuntimeFactories = Readonly<{
  createRepository?: (config: VendorAgentRuntimeConfig) => FirestoreTransactionalRepository;
  loadSigner?: typeof loadCloudRunSecretKeypairSigner;
  assertGenesis?: (rpc: JsonRpcOptions) => Promise<void>;
  createFacilitator?: (config: VendorAgentRuntimeConfig) => PinnedFacilitatorClient;
}>;

export async function buildProductionVendorAgentApp(
  config: VendorAgentRuntimeConfig,
  factories: VendorAgentRuntimeFactories = {},
): Promise<Express> {
  const repository = (factories.createRepository ?? ((runtimeConfig) =>
    createFirestoreTransactionalRepository(
      {
        projectId: runtimeConfig.firestoreProjectId,
        databaseId: runtimeConfig.firestoreDatabaseId,
      },
      { collectionPrefix: runtimeConfig.firestoreCollectionPrefix },
    )))(config);
  const rpc = { rpcUrl: config.solanaRpcUrl };
  await (factories.assertGenesis ?? assertOfficialDevnetGenesis)(rpc);
  const facilitator = (factories.createFacilitator ?? ((runtimeConfig) =>
    new PinnedFacilitatorClient({
      baseUrl: runtimeConfig.facilitatorUrl,
      pinnedOrigin: runtimeConfig.facilitatorOrigin,
    })))(config);
  const supported = await facilitator.getSupported();
  const facilitatorFeePayer = await verifyFacilitatorExactSvmSupport(
    supported,
    config.facilitatorFeePayer,
  );
  const { offers, offerEvaluations } = await loadAndVerifyOfferCatalog(config);
  const receiptSigner = await (factories.loadSigner ?? loadCloudRunSecretKeypairSigner)(
    config.receiptKeyPath,
    {
      allowedRoot: config.receiptSecretRoot,
      expectedPublicKey: config.receiptPublicKey,
    },
  );
  if (
    receiptSigner.address === config.usdcRecipient ||
    receiptSigner.address !== config.receiptPublicKey
  ) {
    throw new Error("Vendor receipt signer identity is not safely separated and pinned");
  }
  const appConfig = {
    agentId: config.agentId,
    agentName: config.agentName,
    agentDescription: config.agentDescription,
    agentOrigin: config.agentOrigin,
    a2aPath: "/a2a",
    vendorTenant: config.vendorTenant,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    facilitatorOrigin: config.facilitatorOrigin,
    facilitatorFeePayer,
    expectedPayerPublicKey: config.expectedPayerPublicKey,
    reconciliationAudience: config.reconciliationAudience,
    allowedReconciliationPrincipal: config.allowedReconciliationPrincipal,
    offers,
    offerEvaluations,
  } as const;
  const agentCardHash = canonicalHash(
    buildVendorAgentCard(appConfig, {
      signerPublicKey: receiptSigner.address,
      keyId: config.receiptKeyId,
    }),
  );
  if (offers.some((offer) => offer.payload.providerAgentCardHash !== agentCardHash)) {
    throw new Error("Signed offer catalog does not bind the published vendor Agent Card");
  }
  await Promise.all(offers.map((offer) => repository.putOffer(offer)));
  return createVendorAgentApp({
    config: appConfig,
    claims: repository,
    offerVerifier: new CanonicalOfferVerifier(config),
    x402: new ProductionVendorX402Gateway(
      facilitator,
      rpc,
      facilitatorFeePayer,
      config.settlementConfirmationAttempts,
      config.settlementConfirmationDelayMs,
    ),
    existingSettlementVerifier: {
      async verifyExistingSettlement(input) {
        if (input.assetMint !== DEVNET_USDC_MINT) {
          throw new Error("Reconciliation only accepts the pinned Devnet USDC mint");
        }
        if (input.payerOwner !== config.expectedPayerPublicKey) {
          throw new Error("Reconciliation payer does not match the pinned executor address");
        }
        await verifySolanaSettlement({
          rpc,
          txSignature: input.txSignature,
          payerOwner: config.expectedPayerPublicKey,
          payeeOwner: input.payeeOwner,
          amountBaseUnits: input.amountBaseUnits,
          assetMint: DEVNET_USDC_MINT,
        });
      },
    },
    reconciliationIamVerifier: new GoogleCloudVendorIamTokenVerifier(),
    recoveryResource: new FirestoreRecoveryResourceProvider(repository, offers),
    receiptSigner: new CanonicalReceiptSigner(receiptSigner, config.receiptKeyId),
    onSafeDiagnostic: (event) => {
      // The event shape contains only allowlisted reason categories and a hash;
      // raw facilitator messages and payment payloads never reach Cloud Logging.
      console.warn(JSON.stringify(event));
    },
  });
}

export type ExpressListen = (app: Express, port: number, host: string) => Promise<Server>;

export const listenExpress: ExpressListen = async (app, port, host) =>
  new Promise<Server>((resolveServer, reject) => {
    const server = app.listen(port, host, () => resolveServer(server));
    server.once("error", reject);
  });

export type StartVendorAgentOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  buildApp?: (config: VendorAgentRuntimeConfig) => Promise<Express>;
  listen?: ExpressListen;
}>;

export async function startVendorAgent(options: StartVendorAgentOptions = {}): Promise<Server> {
  const config = parseVendorAgentRuntimeConfig(options.env ?? process.env);
  const app = await (options.buildApp ?? buildProductionVendorAgentApp)(config);
  return (options.listen ?? listenExpress)(app, config.port, config.host);
}
