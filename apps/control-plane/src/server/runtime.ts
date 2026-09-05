import { buildRecoveryRpcProbe } from "./recovery-rpc-probe.js";
import { FirestoreRecoveryCheckpointStore } from "@uptime402/persistence";
import "server-only";

import { isAbsolute, resolve } from "node:path";

import type { KeyPairSigner } from "@solana/kit";
import {
  Base58Schema,
  IdentifierSchema,
  RecoveryOutcomePayloadSchema,
  TimestampSchema,
  canonicalHash,
  canonicalize,
  computeExecutionPolicyHash,
  normalizePinnedHttpsUrl,
  normalizePinnedOrigin,
  type JsonValue,
  type RecoveryOutcomePayload,
} from "@uptime402/domain";
import {
  loadCloudRunSecretKeypairSigner,
  signEnvelope,
} from "@uptime402/payments";
import {
  FirestoreRuntimeStateRepository,
  createFirestoreTransactionalRepository,
  type AuditEventInput,
  type FirestoreTransactionalRepository,
  type ReservationRecord,
  type ReservationState,
} from "@uptime402/persistence";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";

import { createGeminiModelFromEnvironment } from "./gemini.js";
import {
  captureCounterfactualGeminiSelection,
  type GeminiDecisionRunCapture,
  type GeminiSelectionPairCapture,
} from "./gemini-evidence.js";
import type { RecoveryDecisionModelInput } from "./gemini.js";
import {
  FirestoreRecoveryRouteSchema,
  HealthProbeEvidenceSchema,
  runLiveIncident,
  type ControlPlaneLiveFlowStore,
  type DependencyHealthProbe,
  type DependencyRouter,
  type ExecutorIdentityTokenProvider,
  type FirestoreRecoveryRoute,
  type LiveIncidentRequest,
  type LiveIncidentResult,
  type PersistAuthoritativeContextInput,
  type RecoveryOutcomeSigner,
  type RunLiveIncidentDependencies,
} from "./live-flow.js";
import {
  createProductionOriginBoundFetchFactory,
  type OriginBoundFetchFactory,
} from "./pinned-fetch.js";
import { parseStrictJson } from "./strict-json.js";

const ProbeResponseSchema = z
  .object({
    status: z.literal("healthy"),
    routeActivationId: z.string().min(1).max(128),
    details: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .strict();

const StoredRouteSchema = z
  .object({
    schemaVersion: z.literal("1"),
    recordHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    value: FirestoreRecoveryRouteSchema,
  })
  .strict();

export type ControlPlaneLiveFlowRuntimeConfig = Readonly<{
  firestoreProjectId: string;
  firestoreDatabaseId: string;
  firestoreCollectionPrefix: string;
  vendorAgentOrigin: string;
  executorOrigin: string;
  vendorAgentId: string;
  vendorOfferSignerPublicKey: string;
  vendorOfferSignerKeyId: string;
  vendorReceiptPublicKey: string;
  vendorReceiptKeyId: string;
  outcomeKeyPath: string;
  outcomeSecretRoot: string;
  outcomePublicKey: string;
  outcomeKeyId: string;
  recoveryHealthProbeUrl: string;
  httpTimeoutMs: number;
  httpMaxResponseBytes: number;
}>;

function required(environment: Readonly<NodeJS.ProcessEnv>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function boundedInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function distinctIdentity(
  left: { publicKey: string; keyId: string },
  right: { publicKey: string; keyId: string },
  label: string,
): void {
  if (left.publicKey === right.publicKey || left.keyId === right.keyId) {
    throw new Error(`${label} identities and key IDs must be separate`);
  }
}

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  return resolve(value);
}

/**
 * Parses public identity pins and the control-plane's one outcome-key mount.
 * It deliberately never reads executor-wallet or vendor-private-key variables.
 */
export function parseControlPlaneLiveFlowRuntimeConfig(
  environment: Readonly<NodeJS.ProcessEnv>,
): ControlPlaneLiveFlowRuntimeConfig {
  if (environment.FIRESTORE_EMULATOR_HOST?.trim()) {
    throw new Error("Production control-plane live flow refuses FIRESTORE_EMULATOR_HOST");
  }
  const firestoreCollectionPrefix = required(environment, "FIRESTORE_COLLECTION_PREFIX");
  if (!/^[a-z][a-z0-9_-]{0,47}$/u.test(firestoreCollectionPrefix)) {
    throw new TypeError("FIRESTORE_COLLECTION_PREFIX is invalid");
  }
  const vendorAgentOrigin = normalizePinnedOrigin(required(environment, "VENDOR_AGENT_ORIGIN"));
  const executorOrigin = normalizePinnedOrigin(required(environment, "PAYMENT_EXECUTOR_ORIGIN"));
  if (vendorAgentOrigin === executorOrigin) {
    throw new Error("Vendor and private executor origins must be distinct");
  }
  const recoveryHealthProbeUrl = normalizePinnedHttpsUrl(
    required(environment, "RECOVERY_HEALTH_PROBE_URL"),
    normalizePinnedOrigin(new URL(required(environment, "RECOVERY_HEALTH_PROBE_URL")).origin),
  );
  const offerIdentity = {
    publicKey: Base58Schema.parse(required(environment, "VENDOR_OFFER_SIGNER_PUBLIC_KEY")),
    keyId: required(environment, "VENDOR_OFFER_SIGNER_KEY_ID"),
  };
  const receiptIdentity = {
    publicKey: Base58Schema.parse(required(environment, "VENDOR_RECEIPT_PUBLIC_KEY")),
    keyId: required(environment, "VENDOR_RECEIPT_KEY_ID"),
  };
  const outcomeIdentity = {
    publicKey: Base58Schema.parse(required(environment, "CONTROL_PLANE_OUTCOME_PUBLIC_KEY")),
    keyId: required(environment, "CONTROL_PLANE_OUTCOME_KEY_ID"),
  };
  if (
    offerIdentity.publicKey !== receiptIdentity.publicKey ||
    offerIdentity.keyId !== receiptIdentity.keyId
  ) {
    throw new Error("Vendor offers and receipts must use the same pinned Agent Card authority");
  }
  distinctIdentity(receiptIdentity, outcomeIdentity, "Vendor receipt and control-plane outcome");

  return Object.freeze({
    firestoreProjectId: required(environment, "FIRESTORE_PROJECT_ID"),
    firestoreDatabaseId: environment.FIRESTORE_DATABASE_ID?.trim() || "(default)",
    firestoreCollectionPrefix,
    vendorAgentOrigin,
    executorOrigin,
    vendorAgentId: IdentifierSchema.parse(required(environment, "VENDOR_AGENT_ID")),
    vendorOfferSignerPublicKey: offerIdentity.publicKey,
    vendorOfferSignerKeyId: offerIdentity.keyId,
    vendorReceiptPublicKey: receiptIdentity.publicKey,
    vendorReceiptKeyId: receiptIdentity.keyId,
    outcomeKeyPath: absolutePath(
      required(environment, "CONTROL_PLANE_OUTCOME_KEY_PATH"),
      "CONTROL_PLANE_OUTCOME_KEY_PATH",
    ),
    outcomeSecretRoot: absolutePath(
      required(environment, "CONTROL_PLANE_OUTCOME_SECRET_ROOT"),
      "CONTROL_PLANE_OUTCOME_SECRET_ROOT",
    ),
    outcomePublicKey: outcomeIdentity.publicKey,
    outcomeKeyId: outcomeIdentity.keyId,
    recoveryHealthProbeUrl,
    httpTimeoutMs: boundedInteger(
      environment.HTTP_TIMEOUT_MS?.trim() || "5000",
      "HTTP_TIMEOUT_MS",
      100,
      60_000,
    ),
    httpMaxResponseBytes: boundedInteger(
      environment.HTTP_MAX_RESPONSE_BYTES?.trim() || "1048576",
      "HTTP_MAX_RESPONSE_BYTES",
      1,
      4_194_304,
    ),
  });
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalize(value)) as JsonValue;
}

export class FirestoreControlPlaneLiveFlowStore implements ControlPlaneLiveFlowStore {
  private readonly runtimeState: FirestoreRuntimeStateRepository;

  constructor(readonly repository: FirestoreTransactionalRepository) {
    this.runtimeState = new FirestoreRuntimeStateRepository(repository);
  }

  async persistAuthoritativeContext(input: PersistAuthoritativeContextInput): Promise<void> {
    const expectedContextHash = canonicalHash({
      correlationId: input.correlationId,
      incident: input.incident,
      offers: input.offers,
      selectedOfferId: input.selectedOffer.payload.offerId,
      challenge: input.challenge,
      operation: input.operation,
      executionPolicy: input.executionPolicy,
    });
    if (
      input.contextHash !== expectedContextHash ||
      input.executionPolicy.policyHash !== computeExecutionPolicyHash(input.executionPolicy) ||
      !input.offers.some(
        (offer) => offer.payload.offerId === input.selectedOffer.payload.offerId,
      )
    ) {
      throw new Error("Authoritative control-plane context hash binding failed");
    }
    await this.runtimeState.putIncident(input.incident);
    await Promise.all(input.offers.map((offer) => this.repository.putOffer(offer)));
    await this.repository.putExecutionPolicy(input.executionPolicy);
    await this.repository.putChallenge(input.challenge);
    await this.runtimeState.putOperation(input.operation);
    await this.repository.recordAuditEvent({
      eventId: `context-${input.contextHash.slice("sha256:".length, "sha256:".length + 48)}`,
      type: "control.authoritative_context_persisted",
      occurredAt: input.persistedAt,
      correlationId: input.correlationId,
      incidentId: input.incident.id,
      paymentId: input.challenge.paymentId,
      payload: asJsonValue({
        correlationId: input.correlationId,
        contextHash: input.contextHash,
        selectedOfferId: input.selectedOffer.payload.offerId,
        executionPolicyHash: input.executionPolicy.policyHash,
        challengeHash: input.challenge.challengeHash,
        operationId: input.operation.id,
      }),
    });
  }

  async getReservation(reservationId: string) { return this.repository.getReservation(reservationId); }

  async transitionReservation(
    reservationId: string,
    expectedStates: readonly ReservationState[],
    nextState: ReservationState,
    occurredAt: string,
    patch: {
      txSignature?: string;
      fulfillmentReceiptHash?: string;
      failureReason?: string;
      note?: string;
    } = {},
  ): Promise<ReservationRecord> {
    return this.repository.transitionReservation(
      reservationId,
      expectedStates,
      nextState,
      occurredAt,
      patch,
    );
  }

  async recordAuditEvent(event: AuditEventInput): Promise<void> {
    await this.repository.recordAuditEvent(event);
  }
}

export class GoogleCloudExecutorIdentityTokenProvider
  implements ExecutorIdentityTokenProvider
{
  constructor(private readonly auth = new GoogleAuth()) {}

  async getIdToken(exactAudience: string): Promise<string> {
    const audience = normalizePinnedOrigin(exactAudience);
    const client = await this.auth.getIdTokenClient(audience);
    return client.idTokenProvider.fetchIdToken(audience);
  }
}

class ExistingControlPlaneOutcomeSigner implements RecoveryOutcomeSigner {
  readonly publicKey: string;

  constructor(
    private readonly signer: KeyPairSigner,
    readonly keyId: string,
  ) {
    this.publicKey = signer.address;
  }

  async sign(payload: RecoveryOutcomePayload): Promise<string> {
    return (
      await signEnvelope(payload, RecoveryOutcomePayloadSchema, {
        signer: this.signer,
        keyId: this.keyId,
      })
    ).signature;
  }
}

export class FirestoreDependencyRouter implements DependencyRouter {
  constructor(private readonly repository: FirestoreTransactionalRepository) {}

  async apply(resource: FirestoreRecoveryRoute): Promise<{ applied: true; activationId: string }> {
    const parsed = FirestoreRecoveryRouteSchema.parse(resource);
    const reference = this.repository.firestore
      .collection(`${this.repository.collectionPrefix}_dependency_routes`)
      .doc(parsed.incidentId);
    await this.repository.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists) {
        const existing = StoredRouteSchema.parse(snapshot.data());
        if (canonicalHash(existing.value) !== existing.recordHash) {
          throw new Error("Dependency route document integrity failure");
        }
        if (existing.value.activationId !== parsed.activationId) {
          throw new Error("Incident dependency route is already bound to another activation");
        }
        return;
      }
      transaction.create(reference, {
        schemaVersion: "1",
        recordHash: canonicalHash(parsed),
        value: parsed,
      });
    });
    return { applied: true, activationId: parsed.activationId };
  }
}

export class PinnedHttpDependencyHealthProbe implements DependencyHealthProbe {
  private readonly probeOrigin: string;

  constructor(
    private readonly probeUrl: string,
    private readonly fetchFactory: OriginBoundFetchFactory,
    private readonly maxResponseBytes: number,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.probeOrigin = normalizePinnedOrigin(new URL(probeUrl).origin);
    normalizePinnedHttpsUrl(probeUrl, this.probeOrigin);
  }

  async probe(input: {
    incident: { id: string };
    resource: FirestoreRecoveryRoute;
  }) {
    const started = performance.now();
    const response = await this.fetchFactory.forOrigin(this.probeOrigin)(this.probeUrl, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        "x-uptime402-incident-id": input.incident.id,
        "x-uptime402-route-activation": input.resource.activationId,
      },
    });
    if (response.status < 200 || response.status > 299) {
      throw new Error(`Independent dependency health probe returned ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      throw new TypeError("Independent dependency health probe must return JSON");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxResponseBytes) {
      throw new RangeError("Independent dependency health probe response is too large");
    }
    let decoded: unknown;
    try {
      decoded = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new TypeError("Independent dependency health probe returned invalid UTF-8 JSON");
    }
    const body = ProbeResponseSchema.parse(decoded);
    if (body.routeActivationId !== input.resource.activationId) {
      throw new Error("Independent dependency health probe did not observe the applied route");
    }
    const observedAt = this.now();
    TimestampSchema.parse(observedAt);
    return HealthProbeEvidenceSchema.parse({
      healthy: true,
      observedAt,
      routeActivationId: body.routeActivationId,
      statusCode: response.status,
      latencyMs: Math.max(0, performance.now() - started),
      details: body.details ?? {},
    });
  }
}

export type ProductionControlPlaneLiveFlow = Readonly<{
  config: ControlPlaneLiveFlowRuntimeConfig;
  dependencies: RunLiveIncidentDependencies;
  run(request: LiveIncidentRequest): Promise<LiveIncidentResult>;
  /** Reuses the paid flow's exact baseline and makes one additional Gemini call. */
  captureCounterfactual(input: {
    baseline: GeminiDecisionRunCapture;
    counterfactualInput: RecoveryDecisionModelInput;
    candidateOfferIds: readonly [string, string];
  }): Promise<GeminiSelectionPairCapture>;
}>;

export type BuildProductionControlPlaneLiveFlowOptions = Readonly<{
  environment?: Readonly<NodeJS.ProcessEnv>;
  createRepository?: (
    config: ControlPlaneLiveFlowRuntimeConfig,
  ) => FirestoreTransactionalRepository;
  loadOutcomeSigner?: typeof loadCloudRunSecretKeypairSigner;
  fetchFactory?: OriginBoundFetchFactory;
  identityTokenProvider?: ExecutorIdentityTokenProvider;
  dependencyRouter?: DependencyRouter;
  healthProbe?: DependencyHealthProbe;
}>;

export async function buildProductionControlPlaneLiveFlow(
  options: BuildProductionControlPlaneLiveFlowOptions = {},
): Promise<ProductionControlPlaneLiveFlow> {
  const environment = options.environment ?? process.env;
  const config = parseControlPlaneLiveFlowRuntimeConfig(environment);
  // Reject absent/malformed paid-route RPC bindings before any new payment is possible.
  if (!options.healthProbe) buildRecoveryRpcProbe(environment);
  const gemini = createGeminiModelFromEnvironment(environment);
  if (!gemini.enabled) {
    throw new Error(`Gemini runtime is not configured: ${gemini.reason}`);
  }
  const repository = (options.createRepository ?? ((runtimeConfig) =>
    createFirestoreTransactionalRepository(
      {
        projectId: runtimeConfig.firestoreProjectId,
        databaseId: runtimeConfig.firestoreDatabaseId,
      },
      { collectionPrefix: runtimeConfig.firestoreCollectionPrefix },
    )))(config);
  const outcomeSigner = await (
    options.loadOutcomeSigner ?? loadCloudRunSecretKeypairSigner
  )(config.outcomeKeyPath, {
    allowedRoot: config.outcomeSecretRoot,
    expectedPublicKey: config.outcomePublicKey,
  });
  if (outcomeSigner.address !== config.outcomePublicKey) {
    throw new Error("Control-plane outcome signer identity mismatch");
  }
  const fetchFactory =
    options.fetchFactory ??
    createProductionOriginBoundFetchFactory({
      timeoutMs: config.httpTimeoutMs,
      maxRequestBytes: 512 * 1024,
      maxResponseBytes: config.httpMaxResponseBytes,
    });
  const dependencies: RunLiveIncidentDependencies = {
    model: gemini.adapter,
    store: new FirestoreControlPlaneLiveFlowStore(repository),
    checkpoints: new FirestoreRecoveryCheckpointStore(repository.firestore, repository.collectionPrefix),
    fetchFactory,
    identityTokenProvider:
      options.identityTokenProvider ?? new GoogleCloudExecutorIdentityTokenProvider(),
    vendorIdentity: {
      agentId: config.vendorAgentId,
      offerSignerPublicKey: config.vendorOfferSignerPublicKey,
      offerSignerKeyId: config.vendorOfferSignerKeyId,
      receiptSignerPublicKey: config.vendorReceiptPublicKey,
      receiptSignerKeyId: config.vendorReceiptKeyId,
    },
    outcomeSigner: new ExistingControlPlaneOutcomeSigner(
      outcomeSigner,
      config.outcomeKeyId,
    ),
    dependencyRouter:
      options.dependencyRouter ?? new FirestoreDependencyRouter(repository),
    healthProbe:
      options.healthProbe ??
      new PinnedHttpDependencyHealthProbe(
        config.recoveryHealthProbeUrl,
        fetchFactory,
        config.httpMaxResponseBytes,
      ),
    evidenceLevel: "live-unverified",
    expectedSignerMode: "devnet",
    maxResponseBytes: config.httpMaxResponseBytes,
  };
  return {
    config,
    dependencies,
    run: async (request) =>
      runLiveIncident(
        {
          ...request,
          vendorAgentOrigin: config.vendorAgentOrigin,
          executorOrigin: config.executorOrigin,
        },
        dependencies,
      ),
    captureCounterfactual: async (input) =>
      captureCounterfactualGeminiSelection({
        baseline: input.baseline,
        model: gemini.adapter,
        counterfactualInput: input.counterfactualInput,
        candidateOfferIds: input.candidateOfferIds,
      }),
  };
}
