import { lookup as dnsLookup } from "node:dns/promises";
import { isAbsolute } from "node:path";
import type { Server } from "node:http";

import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  MEMO_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "@x402/svm";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  MandateSchema,
  MandateUnsignedSchema,
  VendorOfferPayloadSchema,
  assertPublicResolvedAddresses,
  canonicalHash,
  computeMandateHash,
  normalizePinnedHttpsUrl,
  normalizePinnedOrigin,
  omitKeys,
  type ExecutionPolicy,
  type Incident,
  type Mandate,
  type PaymentProposal,
  type VendorOffer,
} from "@uptime402/domain";
import {
  FirestoreRuntimeStateRepository,
  RESERVATION_STATES,
  createFirestoreTransactionalRepository,
  type AuthoritativeChallengeRecord,
  type FirestoreTransactionalRepository,
} from "@uptime402/persistence";
import {
  DEVNET_NETWORK_IDENTITY,
  PinnedFacilitatorClient,
  assertOfficialDevnetGenesis,
  buildExactSvmPaymentPayload,
  decodeStrictPaymentRequiredHeader,
  encodeStrictPaymentRequiredHeader,
  loadCloudRunSecretKeypairSigner,
  validateExactSvmTransactionBeforeRelease,
  verifyCanonicalEd25519Signature,
  type JsonRpcOptions,
} from "@uptime402/payments";
import { address, type KeyPairSigner } from "@solana/kit";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { DocumentSnapshot, Firestore } from "@google-cloud/firestore";
import type { Express } from "express";
import { z } from "zod";

import {
  GoogleCloudIamTokenVerifier,
  createPaymentExecutorApp,
  type AuthoritySignatureVerifier,
  type AuthoritativeMandateSnapshot,
  type AuthoritativeOperation,
  type CachedPaymentAuthorization,
  type ExecutorAuthoritativeState,
  type IamTokenVerifier,
  type MandateAdministrationResult,
  type PaymentAuthorizationStore,
  type PrivateX402PayloadSigner,
  type StoredPaymentChallenge,
  type TransactionPlanInspector,
  type VendorTransportInspector,
} from "./index.js";

const Base58PublicKeySchema = z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const PositiveIntegerSchema = z.string().regex(/^[1-9][0-9]*$/);

const StoredEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("1"),
    recordHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    value: z.unknown(),
  })
  .strict();

const ActivationSchema = z
  .object({
    mandateId: z.string().min(1).max(128),
    mandateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    executionPolicyHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    status: z.enum(["active", "revoked"]),
    version: z.number().int().positive(),
    updatedAt: z.string().datetime({ offset: true }),
    principal: z.string().min(1).max(256),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

const CachedAuthorizationSchema = z
  .object({
    reservationId: z.string().min(1).max(128),
    reservationVersion: z.number().int().positive(),
    requestFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    paymentId: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(128),
    mandateId: z.string().min(1).max(128),
    mandateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    executionPolicyHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    mandateActivationVersion: z.number().int().positive(),
    mandateActivationHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    authorizationContextHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    authorizationExpiresAt: z.string().datetime({ offset: true }),
    authorizationPublishedAt: z.string().datetime({ offset: true }),
    paymentSignatureHeader: z.string().min(1).max(256_000),
    signedTransactionSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    signerMode: z.literal("devnet"),
  })
  .strict();

const ReservationRecordSchema = z
  .object({
    reservationId: z.string().min(1).max(128),
    incidentId: z.string().min(1).max(128),
    mandateId: z.string().min(1).max(128),
    paymentId: z.string().min(1).max(128),
    nonce: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(128),
    requestFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    amountBaseUnits: z.string().regex(/^[1-9][0-9]*$/),
    budgetDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    state: z.enum(RESERVATION_STATES),
    version: z.number().int().positive(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    stateHistory: z.array(z.object({
      state: z.enum(RESERVATION_STATES),
      at: z.string().datetime({ offset: true }),
      note: z.string().optional(),
    }).strict()).min(1),
    txSignature: z.string().optional(),
    fulfillmentReceiptHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    failureReason: z.string().optional(),
  })
  .strict();

export type PaymentExecutorRuntimeConfig = Readonly<{
  host: string;
  port: number;
  firestoreProjectId: string;
  firestoreDatabaseId: string;
  firestoreCollectionPrefix: string;
  audience: string;
  controlPlanePrincipal: string;
  operatorPrincipals: readonly string[];
  mandateIssuerPrincipal: string;
  mandateSignerPublicKey: string;
  mandateSignerKeyId: string;
  offerSignerPublicKey: string;
  offerSignerKeyId: string;
  executorWalletPath: string;
  executorSecretRoot: string;
  executorPublicKey: string;
  solanaRpcUrl: string;
  facilitatorUrl: string;
  facilitatorOrigin: string;
  allowedVendorOrigins: readonly string[];
  networkFeeUpperBoundLamports: string;
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

function parsePrincipalList(value: string, name: string): readonly string[] {
  const values = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new TypeError(`${name} must contain distinct comma-separated principals`);
  }
  return Object.freeze(values);
}

function parseOriginList(value: string): readonly string[] {
  const origins = value.split(",").map((entry) => normalizePinnedOrigin(entry.trim()));
  if (origins.length === 0 || new Set(origins).size !== origins.length) {
    throw new TypeError("ALLOWED_VENDOR_ORIGINS must contain distinct HTTPS origins");
  }
  return Object.freeze(origins);
}

function mandateAuditEventId(event: "armed" | "revoked", mandateId: string, version: number): string {
  return `evt_${canonicalHash({ event, mandateId, version }).slice("sha256:".length, "sha256:".length + 40)}`;
}

function parseCredentialFreeHttpsUrl(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError(`${name} must be a credential-free HTTPS URL`);
  }
  return url.toString();
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
    throw new Error("Production payment executor refuses FIRESTORE_EMULATOR_HOST");
  }
}

export function parsePaymentExecutorRuntimeConfig(
  env: NodeJS.ProcessEnv,
): PaymentExecutorRuntimeConfig {
  assertDevnetEnvironment(env);
  const facilitatorUrl = parseCredentialFreeHttpsUrl(
    required(env, "X402_FACILITATOR_URL"),
    "X402_FACILITATOR_URL",
  );
  const executorWalletPath = required(env, "EXECUTOR_WALLET_KEYPAIR_PATH");
  if (!isAbsolute(executorWalletPath)) {
    throw new TypeError("EXECUTOR_WALLET_KEYPAIR_PATH must be absolute");
  }
  const executorSecretRoot = required(env, "EXECUTOR_WALLET_SECRET_ROOT");
  if (!isAbsolute(executorSecretRoot)) {
    throw new TypeError("EXECUTOR_WALLET_SECRET_ROOT must be absolute");
  }
  const audience = normalizePinnedOrigin(required(env, "EXECUTOR_EXPECTED_AUDIENCE"));
  const collectionPrefix = required(env, "FIRESTORE_COLLECTION_PREFIX");
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(collectionPrefix)) {
    throw new TypeError("FIRESTORE_COLLECTION_PREFIX is invalid");
  }
  return Object.freeze({
    host: env.HOST?.trim() || "0.0.0.0",
    port: parsePort(required(env, "PORT")),
    firestoreProjectId: required(env, "FIRESTORE_PROJECT_ID"),
    firestoreDatabaseId: env.FIRESTORE_DATABASE_ID?.trim() || "(default)",
    firestoreCollectionPrefix: collectionPrefix,
    audience,
    controlPlanePrincipal: required(env, "CONTROL_PLANE_SERVICE_ACCOUNT"),
    operatorPrincipals: parsePrincipalList(required(env, "OPERATOR_PRINCIPAL"), "OPERATOR_PRINCIPAL"),
    mandateIssuerPrincipal: required(env, "MANDATE_ISSUER_PRINCIPAL"),
    mandateSignerPublicKey: Base58PublicKeySchema.parse(required(env, "MANDATE_SIGNER_PUBLIC_KEY")),
    mandateSignerKeyId: required(env, "MANDATE_SIGNER_KEY_ID"),
    offerSignerPublicKey: Base58PublicKeySchema.parse(required(env, "VENDOR_OFFER_SIGNER_PUBLIC_KEY")),
    offerSignerKeyId: required(env, "VENDOR_OFFER_SIGNER_KEY_ID"),
    executorWalletPath,
    executorSecretRoot,
    executorPublicKey: Base58PublicKeySchema.parse(required(env, "EXECUTOR_WALLET_PUBLIC_KEY")),
    solanaRpcUrl: parseCredentialFreeHttpsUrl(required(env, "SOLANA_RPC_URL"), "SOLANA_RPC_URL"),
    facilitatorUrl,
    facilitatorOrigin: normalizePinnedOrigin(new URL(facilitatorUrl).origin),
    allowedVendorOrigins: parseOriginList(required(env, "ALLOWED_VENDOR_ORIGINS")),
    networkFeeUpperBoundLamports: PositiveIntegerSchema.parse(
      required(env, "ESTIMATED_NETWORK_FEE_LAMPORTS"),
    ),
  });
}

async function uniqueDocumentByValue(
  firestore: Firestore,
  collectionName: string,
  field: string,
  value: string,
): Promise<DocumentSnapshot | null> {
  const snapshot = await firestore.collection(collectionName).where(field, "==", value).limit(2).get();
  if (snapshot.size > 1) throw new Error(`Duplicate authoritative ${field} records`);
  return snapshot.docs[0] ?? null;
}

function parseHashedEnvelope<T>(
  snapshot: DocumentSnapshot,
  schema: z.ZodType<T>,
  label: string,
): T | null {
  if (!snapshot.exists) return null;
  const envelope = StoredEnvelopeSchema.parse(snapshot.data());
  if (canonicalHash(envelope.value) !== envelope.recordHash) {
    throw new Error(`${label} envelope integrity failure`);
  }
  return schema.parse(envelope.value);
}

class FirestoreExecutorAuthoritativeState implements ExecutorAuthoritativeState {
  private readonly runtimeState: FirestoreRuntimeStateRepository;

  constructor(
    private readonly repository: FirestoreTransactionalRepository,
    private readonly facilitatorOrigin: string,
  ) {
    this.runtimeState = new FirestoreRuntimeStateRepository(repository);
  }

  private collection(suffix: string): string {
    return `${this.repository.collectionPrefix}_${suffix}`;
  }

  async loadMandateSnapshot(mandateId: string): Promise<AuthoritativeMandateSnapshot | null> {
    const [mandate, activationSnapshot] = await Promise.all([
      this.repository.getMandate(mandateId),
      this.repository.firestore.collection(this.collection("mandate_activations")).doc(mandateId).get(),
    ]);
    if (!mandate || !activationSnapshot.exists) return null;
    const parsedActivation = ActivationSchema.parse(activationSnapshot.data());
    const activation: AuthoritativeMandateSnapshot["activation"] = {
      ...parsedActivation,
      mandateHash: parsedActivation.mandateHash as `sha256:${string}`,
      executionPolicyHash: parsedActivation.executionPolicyHash as `sha256:${string}`,
      activationHash: canonicalHash(parsedActivation),
    };
    if (
      activation.mandateId !== mandateId ||
      activation.mandateHash !== mandate.mandateHash ||
      activation.executionPolicyHash !== mandate.executionPolicyHash
    ) throw new Error("Mandate activation identity/hash mismatch");
    return {
      mandate: activation.status === "active" ? mandate : { ...mandate, revokedAt: activation.updatedAt },
      activation,
    };
  }

  async loadOffer(offerId: string): Promise<VendorOffer | null> {
    return this.repository.getOffer(offerId);
  }

  async loadChallenge(challengeHash: string): Promise<StoredPaymentChallenge | null> {
    const snapshot = await uniqueDocumentByValue(
      this.repository.firestore,
      this.collection("challenges"),
      "value.challengeHash",
      challengeHash,
    );
    if (!snapshot) return null;
    const record = await this.repository.getChallenge(snapshot.id);
    if (!record) return null;
    return this.toStoredChallenge(record);
  }

  private toStoredChallenge(record: AuthoritativeChallengeRecord): StoredPaymentChallenge {
    const paymentRequired = z.custom<PaymentRequired>().parse(record.payload);
    const paymentRequiredHeader = encodeStrictPaymentRequiredHeader(paymentRequired);
    const decoded = decodeStrictPaymentRequiredHeader(paymentRequiredHeader);
    if (canonicalHash(decoded) !== record.challengeHash || decoded.accepts.length !== 1) {
      throw new Error("Authoritative challenge does not bind one strict PaymentRequired option");
    }
    const requirement = decoded.accepts[0]!;
    return {
      verified: true,
      challengeHash: record.challengeHash,
      expiresAt: record.expiresAt,
      scheme: "exact",
      network: requirement.network,
      assetMint: requirement.asset,
      amountBaseUnits: requirement.amount,
      payee: requirement.payTo,
      method: "POST",
      resourceUrl: decoded.resource.url,
      facilitatorOrigin: this.facilitatorOrigin,
      paymentRequiredHeader,
    };
  }

  async loadExecutionPolicy(policyHash: string): Promise<ExecutionPolicy | null> {
    const snapshot = await uniqueDocumentByValue(
      this.repository.firestore,
      this.collection("execution_policies"),
      "value.policyHash",
      policyHash,
    );
    return snapshot ? this.repository.getExecutionPolicy(snapshot.id) : null;
  }

  async loadIncident(incidentId: string): Promise<Incident | null> {
    return this.runtimeState.getIncident(incidentId);
  }

  async loadOperation(operationId: string): Promise<AuthoritativeOperation | null> {
    const record = await this.runtimeState.getOperation(operationId);
    if (!record) return null;
    if (record.id !== operationId || record.request.operationId !== operationId) {
      throw new Error("Authoritative operation identity mismatch");
    }
    return { requiredCapability: record.requiredCapability, subject: record.subject, request: record.request };
  }

  async armMandate(
    mandate: Mandate,
    principal: string,
    at: string,
  ): Promise<MandateAdministrationResult> {
    await this.repository.putMandate(mandate);
    const reference = this.repository.firestore
      .collection(this.collection("mandate_activations"))
      .doc(mandate.id);
    const result = await this.repository.firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(reference);
      const previous = existing.exists ? ActivationSchema.parse(existing.data()) : null;
      const activation = ActivationSchema.parse({
        mandateId: mandate.id,
        mandateHash: mandate.mandateHash,
        executionPolicyHash: mandate.executionPolicyHash,
        status: "active",
        version: (previous?.version ?? 0) + 1,
        updatedAt: at,
        principal,
      });
      transaction.set(reference, activation);
      return { mandateId: mandate.id, version: activation.version, event: "armed" as const, at };
    });
    await this.repository.recordAuditEvent({
      eventId: mandateAuditEventId("armed", mandate.id, result.version),
      type: "mandate.armed",
      occurredAt: at,
      mandateId: mandate.id,
      payload: {
        version: result.version,
        principal,
        mandateHash: mandate.mandateHash,
      },
    });
    return result;
  }

  async revokeMandate(
    mandateId: string,
    principal: string,
    revokedAt: string,
    reason: string,
  ): Promise<MandateAdministrationResult | null> {
    const reference = this.repository.firestore
      .collection(this.collection("mandate_activations"))
      .doc(mandateId);
    const result = await this.repository.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return null;
      const previous = ActivationSchema.parse(snapshot.data());
      const activation = ActivationSchema.parse({
        mandateId,
        mandateHash: previous.mandateHash,
        executionPolicyHash: previous.executionPolicyHash,
        status: "revoked",
        version: previous.version + 1,
        updatedAt: revokedAt,
        principal,
        reason,
      });
      transaction.set(reference, activation);
      return { mandateId, version: activation.version, event: "revoked" as const, at: revokedAt };
    });
    if (!result) return null;
    await this.repository.recordAuditEvent({
      eventId: mandateAuditEventId("revoked", mandateId, result.version),
      type: "mandate.revoked",
      occurredAt: revokedAt,
      mandateId,
      payload: {
        version: result.version,
        principal,
        reason,
      },
    });
    return result;
  }
}

class CanonicalAuthoritySignatureVerifier implements AuthoritySignatureVerifier {
  constructor(private readonly config: PaymentExecutorRuntimeConfig) {}

  async verifyMandateAttestation(mandate: Mandate): Promise<boolean> {
    if (mandate.attestation.kid !== this.config.mandateSignerKeyId) return false;
    const payload = omitKeys(mandate, ["mandateHash", "attestation"] as const);
    return verifyCanonicalEd25519Signature({
      payload,
      payloadSchema: MandateUnsignedSchema,
      signerPublicKey: this.config.mandateSignerPublicKey,
      signature: mandate.attestation.signature,
    }).catch(() => false);
  }

  async verifyOfferSignature(offer: VendorOffer): Promise<boolean> {
    if (
      offer.keyId !== this.config.offerSignerKeyId ||
      offer.signer !== this.config.offerSignerPublicKey
    ) return false;
    return verifyCanonicalEd25519Signature({
      payload: offer.payload,
      payloadSchema: VendorOfferPayloadSchema,
      signerPublicKey: this.config.offerSignerPublicKey,
      signature: offer.signature,
    }).catch(() => false);
  }
}

export class FirestorePaymentAuthorizationStore implements PaymentAuthorizationStore {
  constructor(private readonly repository: FirestoreTransactionalRepository) {}

  private reference(reservationId: string) {
    return this.repository.firestore
      .collection(`${this.repository.collectionPrefix}_payment_authorizations`)
      .doc(reservationId);
  }

  private activationReference(mandateId: string) {
    return this.repository.firestore
      .collection(`${this.repository.collectionPrefix}_mandate_activations`)
      .doc(mandateId);
  }

  private mandateReference(mandateId: string) {
    return this.repository.firestore
      .collection(`${this.repository.collectionPrefix}_mandates`)
      .doc(mandateId);
  }

  private reservationReference(reservationId: string) {
    return this.repository.firestore
      .collection(`${this.repository.collectionPrefix}_reservations`)
      .doc(reservationId);
  }

  private guardIsReleasable(input: {
    authorization: CachedPaymentAuthorization;
    activation: z.infer<typeof ActivationSchema>;
    mandate: Mandate;
    reservation: z.infer<typeof ReservationRecordSchema>;
    checkedAt: string;
    authorizationContextHash?: `sha256:${string}`;
    requestFingerprint?: `sha256:${string}`;
  }): boolean {
    const activationHash = canonicalHash(input.activation);
    const mandateIntegrityValid =
      input.mandate.mandateHash === computeMandateHash(input.mandate) &&
      input.mandate.id === input.authorization.mandateId &&
      input.mandate.mandateHash === input.authorization.mandateHash &&
      input.mandate.executionPolicyHash === input.authorization.executionPolicyHash;
    const activationValid =
      input.activation.status === "active" &&
      input.activation.mandateId === input.authorization.mandateId &&
      input.activation.mandateHash === input.authorization.mandateHash &&
      input.activation.executionPolicyHash === input.authorization.executionPolicyHash &&
      input.activation.version === input.authorization.mandateActivationVersion &&
      activationHash === input.authorization.mandateActivationHash;
    const reservationValid =
      input.reservation.state === "reserved" &&
      input.reservation.reservationId === input.authorization.reservationId &&
      input.reservation.version === input.authorization.reservationVersion &&
      input.reservation.mandateId === input.authorization.mandateId &&
      input.reservation.paymentId === input.authorization.paymentId &&
      input.reservation.idempotencyKey === input.authorization.idempotencyKey &&
      input.reservation.requestFingerprint === input.authorization.requestFingerprint;
    const requestValid =
      (input.authorizationContextHash === undefined ||
        input.authorization.authorizationContextHash === input.authorizationContextHash) &&
      (input.requestFingerprint === undefined ||
        input.authorization.requestFingerprint === input.requestFingerprint);
    const checkedAt = Date.parse(input.checkedAt);
    return mandateIntegrityValid && activationValid && reservationValid && requestValid &&
      Date.parse(input.authorization.authorizationPublishedAt) <= checkedAt &&
      checkedAt < Date.parse(input.authorization.authorizationExpiresAt);
  }

  async getReleasable(input: {
    reservationId: string;
    authorizationContextHash: `sha256:${string}`;
    requestFingerprint: `sha256:${string}`;
    checkedAt: string;
  }) {
    const reference = this.reference(input.reservationId);
    return this.repository.firestore.runTransaction(async (transaction) => {
      const authorizationSnapshot = await transaction.get(reference);
      const authorization = parseHashedEnvelope(
        authorizationSnapshot,
        CachedAuthorizationSchema,
        "Payment authorization cache",
      ) as CachedPaymentAuthorization | null;
      if (!authorization) return { kind: "missing" as const };
      const [activationSnapshot, mandateSnapshot, reservationSnapshot] = await transaction.getAll(
        this.activationReference(authorization.mandateId),
        this.mandateReference(authorization.mandateId),
        this.reservationReference(authorization.reservationId),
      );
      const activation = activationSnapshot!.exists
        ? ActivationSchema.parse(activationSnapshot!.data())
        : null;
      const mandate = parseHashedEnvelope(mandateSnapshot!, MandateSchema, "Mandate");
      const reservation = parseHashedEnvelope(
        reservationSnapshot!,
        ReservationRecordSchema,
        "Reservation",
      );
      // Evaluate the wall clock inside every Firestore transaction attempt.
      // A caller timestamp captured before a slow read must not extend an
      // expired challenge/offer/proposal/mandate authorization.
      const checkedAt = new Date().toISOString();
      if (!activation || !mandate || !reservation || !this.guardIsReleasable({
        authorization,
        activation,
        mandate,
        reservation,
        checkedAt,
        authorizationContextHash: input.authorizationContextHash,
        requestFingerprint: input.requestFingerprint,
      })) return { kind: "not_releasable" as const };
      return { kind: "releasable" as const, authorization };
    }, { readOnly: true });
  }

  async publishIfActive(
    value: CachedPaymentAuthorization,
  ): Promise<"stored" | "existing" | "not_releasable"> {
    const parsed = CachedAuthorizationSchema.parse(value);
    const reference = this.reference(parsed.reservationId);
    const activationReference = this.activationReference(parsed.mandateId);
    const mandateReference = this.mandateReference(parsed.mandateId);
    const reservationReference = this.reservationReference(parsed.reservationId);
    return this.repository.firestore.runTransaction(async (transaction) => {
      const [snapshot, activationSnapshot, mandateSnapshot, reservationSnapshot] = await transaction.getAll(
        reference,
        activationReference,
        mandateReference,
        reservationReference,
      );
      const activation = activationSnapshot!.exists
        ? ActivationSchema.parse(activationSnapshot!.data())
        : null;
      const mandate = parseHashedEnvelope(mandateSnapshot!, MandateSchema, "Mandate");
      const reservation = parseHashedEnvelope(
        reservationSnapshot!,
        ReservationRecordSchema,
        "Reservation",
      );
      const checkedAt = new Date().toISOString();
      if (!activation || !mandate || !reservation || !this.guardIsReleasable({
        authorization: parsed as CachedPaymentAuthorization,
        activation,
        mandate,
        reservation,
        checkedAt,
      })) return "not_releasable";
      if (snapshot!.exists) return "existing";
      transaction.create(reference, {
        schemaVersion: "1",
        recordHash: canonicalHash(parsed),
        value: parsed,
      });
      return "stored";
    });
  }
}

class ProductionExactSvmPayloadSigner implements PrivateX402PayloadSigner {
  readonly publicKey: string;

  constructor(
    private readonly signer: KeyPairSigner,
    private readonly rpc: JsonRpcOptions,
    private readonly networkFeeUpperBoundLamports: string,
  ) {
    this.publicKey = signer.address;
  }

  async createPaymentPayload(input: {
    paymentRequired: PaymentRequired;
    requirements: PaymentRequirements;
    paymentId: string;
    executionPolicy: ExecutionPolicy;
  }) {
    const built = await buildExactSvmPaymentPayload({
      paymentRequired: input.paymentRequired,
      paymentId: input.paymentId,
      signer: this.signer,
      rpc: this.rpc,
      expected: {
        amountBaseUnits: input.requirements.amount,
        payee: input.requirements.payTo,
        resourceUrl: input.paymentRequired.resource.url,
      },
    });
    await validateExactSvmTransactionBeforeRelease(built.paymentPayload, {
      clusterLabel: DEVNET_NETWORK_IDENTITY.clusterLabel,
      genesisHash: DEVNET_NETWORK_IDENTITY.genesisHash,
      network: input.executionPolicy.network.x402NetworkId,
      sdkNetworkId: DEVNET_NETWORK_IDENTITY.sdkNetworkId,
      assetMint: input.executionPolicy.assetMint,
      assetDecimals: input.executionPolicy.assetDecimals,
      amountBaseUnits: input.requirements.amount,
      payee: input.requirements.payTo,
      payer: input.executionPolicy.executorPublicKey,
      feePayer: input.executionPolicy.feePayer,
      paymentId: input.paymentId,
      allowedProgramIds: input.executionPolicy.allowedProgramIds,
      allowedAccountKeys: input.executionPolicy.allowedAccountRules,
      maxNetworkFeeLamports: input.executionPolicy.maxNetworkFeeLamports,
      configuredNetworkFeeUpperBoundLamports: this.networkFeeUpperBoundLamports,
      rpc: this.rpc,
    });
    return { paymentPayload: built.paymentPayload, signerMode: "devnet" as const };
  }
}

class ProductionVendorTransportInspector implements VendorTransportInspector {
  constructor(
    private readonly allowedOrigins: readonly string[],
    private readonly lookup: typeof dnsLookup = dnsLookup,
  ) {}

  async inspect(resourceUrl: string) {
    const normalized = this.allowedOrigins
      .map((origin) => {
        try {
          return normalizePinnedHttpsUrl(resourceUrl, origin);
        } catch {
          return null;
        }
      })
      .find((value): value is string => value !== null);
    if (!normalized) return { redirectsDisabled: true, resolvedAddressesPublic: false };
    const addresses = await this.lookup(new URL(normalized).hostname, { all: true, verbatim: true });
    try {
      assertPublicResolvedAddresses(addresses.map(({ address }) => address));
      return { redirectsDisabled: true, resolvedAddressesPublic: true };
    } catch {
      return { redirectsDisabled: true, resolvedAddressesPublic: false };
    }
  }
}

class ExactSvmTransactionPlanInspector implements TransactionPlanInspector {
  constructor(
    private readonly executorPublicKey: string,
    private readonly networkFeeUpperBoundLamports: string,
  ) {}

  async inspect(input: {
    paymentRequired: PaymentRequired;
    requirements: PaymentRequirements;
    proposal: PaymentProposal;
    executionPolicy: ExecutionPolicy;
  }) {
    const feePayer = input.requirements.extra.feePayer;
    if (typeof feePayer !== "string") throw new Error("x402 challenge is missing its facilitator fee payer");
    const [sourceTokenAccount] = await findAssociatedTokenPda({
      mint: address(input.requirements.asset),
      owner: address(this.executorPublicKey),
      tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
    });
    const [destinationTokenAccount] = await findAssociatedTokenPda({
      mint: address(input.requirements.asset),
      owner: address(input.requirements.payTo),
      tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
    });
    const programIds = [
      COMPUTE_BUDGET_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      MEMO_PROGRAM_ADDRESS,
    ];
    const accountKeys = [
      feePayer,
      this.executorPublicKey,
      input.requirements.asset,
      sourceTokenAccount,
      destinationTokenAccount,
    ];
    const requirementMemo = input.requirements.extra.memo;
    const planVerified =
      input.paymentRequired.x402Version === 2 &&
      input.requirements.scheme === "exact" &&
      input.requirements.network === input.executionPolicy.network.x402NetworkId &&
      input.requirements.asset === input.executionPolicy.assetMint &&
      input.executionPolicy.assetDecimals === 6 &&
      input.executionPolicy.executorPublicKey === this.executorPublicKey &&
      feePayer === input.executionPolicy.feePayer &&
      requirementMemo === input.proposal.paymentId &&
      programIds.every((programId) => input.executionPolicy.allowedProgramIds.includes(programId)) &&
      accountKeys.every((accountKey) => input.executionPolicy.allowedAccountRules.includes(accountKey)) &&
      BigInt(this.networkFeeUpperBoundLamports) <=
        BigInt(input.executionPolicy.maxNetworkFeeLamports);
    return {
      planVerified,
      programIds,
      accountKeys,
      feePayer,
      executorPublicKey: this.executorPublicKey,
      networkFeeUpperBoundLamports: this.networkFeeUpperBoundLamports,
    };
  }
}

export type PaymentExecutorRuntimeFactories = Readonly<{
  createRepository?: (config: PaymentExecutorRuntimeConfig) => FirestoreTransactionalRepository;
  loadSigner?: typeof loadCloudRunSecretKeypairSigner;
  assertGenesis?: (rpc: JsonRpcOptions) => Promise<void>;
  iamVerifier?: IamTokenVerifier;
}>;

export async function buildProductionPaymentExecutorApp(
  config: PaymentExecutorRuntimeConfig,
  factories: PaymentExecutorRuntimeFactories = {},
): Promise<Express> {
  // Construction intentionally happens only in this private service process.
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
  const signer = await (factories.loadSigner ?? loadCloudRunSecretKeypairSigner)(
    config.executorWalletPath,
    {
      allowedRoot: config.executorSecretRoot,
      expectedPublicKey: config.executorPublicKey,
    },
  );
  if (signer.address !== config.executorPublicKey) throw new Error("Executor signer identity mismatch");

  // Validate facilitator pinning at startup even though only the vendor calls verify/settle.
  new PinnedFacilitatorClient({
    baseUrl: config.facilitatorUrl,
    pinnedOrigin: config.facilitatorOrigin,
  });
  return createPaymentExecutorApp({
    config: {
      audience: config.audience,
      allowedControlPlanePrincipal: config.controlPlanePrincipal,
      allowedOperatorPrincipals: config.operatorPrincipals,
      expectedMandateIssuerPrincipal: config.mandateIssuerPrincipal,
      facilitatorOrigin: config.facilitatorOrigin,
      signerPrivateBoundaryVerified: true,
    },
    iamVerifier: factories.iamVerifier ?? new GoogleCloudIamTokenVerifier(),
    authority: new FirestoreExecutorAuthoritativeState(repository, config.facilitatorOrigin),
    signatureVerifier: new CanonicalAuthoritySignatureVerifier(config),
    reservations: repository,
    authorizationStore: new FirestorePaymentAuthorizationStore(repository),
    networkObserver: { observe: async () => {
      await assertOfficialDevnetGenesis(rpc);
      return {
        clusterLabel: DEVNET_NETWORK_IDENTITY.clusterLabel,
        rpcGenesisHash: DEVNET_NETWORK_IDENTITY.genesisHash,
        sdkNetworkId: DEVNET_NETWORK_IDENTITY.sdkNetworkId,
      };
    } },
    transportInspector: new ProductionVendorTransportInspector(config.allowedVendorOrigins),
    transactionInspector: new ExactSvmTransactionPlanInspector(
      config.executorPublicKey,
      config.networkFeeUpperBoundLamports,
    ),
    signer: new ProductionExactSvmPayloadSigner(
      signer,
      rpc,
      config.networkFeeUpperBoundLamports,
    ),
  });
}

export type ExpressListen = (
  app: Express,
  port: number,
  host: string,
) => Promise<Server>;

export const listenExpress: ExpressListen = async (app, port, host) =>
  new Promise<Server>((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });

export type StartPaymentExecutorOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  buildApp?: (config: PaymentExecutorRuntimeConfig) => Promise<Express>;
  listen?: ExpressListen;
}>;

export async function startPaymentExecutor(
  options: StartPaymentExecutorOptions = {},
): Promise<Server> {
  const config = parsePaymentExecutorRuntimeConfig(options.env ?? process.env);
  const app = await (options.buildApp ?? buildProductionPaymentExecutorApp)(config);
  return (options.listen ?? listenExpress)(app, config.port, config.host);
}
