import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  Base58Schema,
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  ExecutionPolicySchema,
  FulfillmentReceiptPayloadSchema,
  FulfillmentReceiptSchema,
  IdentifierSchema,
  IncidentSchema,
  RecoveryDecisionSchema,
  RecoveryOutcomePayloadSchema,
  Sha256Schema,
  SignedEnvelopeSchema,
  TimestampSchema,
  canonicalHash,
  canonicalize,
  computeExecutionPolicyHash,
  computeSignedEnvelopeHash,
  createIncidentRunBindingHash,
  createRequestFingerprint,
  sha256Bytes,
} from "@uptime402/domain";
import {
  DEVNET_SVM_SDK_NETWORK_ID,
  USDC_DECIMALS,
  inspectExactSvmPaymentTransaction,
  validateExactSvmPayerSignature,
  verifyCanonicalEd25519Signature,
  verifySolanaSettlement,
  type VerifiedSolanaSettlement,
} from "@uptime402/payments";
import { z } from "zod";

import {
  RecoveryDecisionModelInputSchema,
  type RecoveryDecisionModel,
} from "../apps/control-plane/src/server/gemini.js";
import {
  LiveGeminiDecisionRunCaptureSchema,
  LiveGeminiSelectionPairCaptureSchema,
  captureCounterfactualGeminiSelection as captureSharedCounterfactualGeminiSelection,
  combineGeminiSelectionPair,
  runCapturedGeminiDecision,
  type GeminiDecisionRunCapture,
} from "../apps/control-plane/src/server/gemini-evidence.js";
import type {
  AutomaticDenialBindingHashes,
  AutomaticDenialBindings,
  AutomaticDenialResults,
  OperatorRunIncidentRequest,
} from "../apps/control-plane/src/server/operator-boundary.js";

import {
  AttestationsSchema,
  DenialSchema,
  EvidenceSchema,
  PolicyEvidenceSchema,
  ProjectSchema,
  SignedOfferSchema,
  assertDenialSemantics,
  assertP0DualDenialSet,
  assertProjectIamBoundary,
  parseJsonRejectingDuplicateKeys,
  verifyMoneyExplorerAndPolicy,
  verifyOfferEnvelopeForEvidence,
  verifyX402Trace,
  type Evidence,
  type EvidenceAttestations,
  type EvidenceDenial,
  type EvidenceProject,
  type EvidenceSelection,
} from "./verify-evidence.js";
import { isCloudRunOriginBound } from "./cloud-run-evidence.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;

const PolicyValueSchema = z.union([
  z.boolean(),
  z.null(),
  z.number().finite(),
  z.string().max(4_096),
  z.array(z.string().max(1_024)).max(512),
]);

const PolicyCheckCaptureSchema = z
  .object({
    rule: z.string().min(1).max(128),
    expected: PolicyValueSchema,
    actual: PolicyValueSchema,
    pass: z.literal(true),
  })
  .strict();

const ReservationStateSchema = z.enum([
  "proposed",
  "reserved",
  "submitted",
  "confirmed",
  "fulfilled",
  "committed",
  "denied",
  "released",
  "unknown",
  "refunded",
]);

const ReservationCaptureSchema = z
  .object({
    reservationId: IdentifierSchema,
    incidentId: IdentifierSchema,
    mandateId: IdentifierSchema,
    paymentId: IdentifierSchema,
    nonce: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
    requestFingerprint: Sha256Schema,
    amountBaseUnits: z.string().regex(POSITIVE_INTEGER),
    budgetDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    state: z.literal("committed"),
    version: z.number().int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    stateHistory: z
      .array(
        z
          .object({
            state: ReservationStateSchema,
            at: TimestampSchema,
            note: z.string().max(2_000).optional(),
          })
          .strict(),
      )
      .min(5),
    txSignature: Base58Schema,
    fulfillmentReceiptHash: Sha256Schema,
    failureReason: z.string().max(2_000).optional(),
  })
  .strict();

export const PolicyReservationCaptureSchema = z
  .object({
    reservation: ReservationCaptureSchema,
    remainingBeforeBaseUnits: z.string().regex(POSITIVE_INTEGER),
    remainingAfterReserveBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
    remainingAfterCommitBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
    rules: z.array(PolicyCheckCaptureSchema).min(1).max(128),
  })
  .strict();

const CapturedRequestSchema = z
  .object({
    incidentId: IdentifierSchema,
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

export type CapturedLiveIncidentRequest = z.infer<typeof CapturedRequestSchema>;

const EventSchema = z
  .object({
    sequence: z.number().int().positive(),
    correlationId: IdentifierSchema,
    kind: z.string().min(1).max(128),
    occurredAt: TimestampSchema,
    protocolLabel: z.string().min(1).max(256),
    evidenceLevel: z.literal("live-unverified"),
    transactionCreated: z.boolean(),
    txSignature: z.union([Base58Schema, z.null()]),
    details: z.record(z.string(), z.unknown()),
  })
  .strict();

const RecoveryOutcomeEnvelopeSchema = SignedEnvelopeSchema(RecoveryOutcomePayloadSchema);

const RecoveryResourceSchema = z
  .object({
    version: z.literal("1"),
    kind: z.literal("firestore_recovery_route"),
    activationId: z.string().min(1).max(128),
    incidentId: IdentifierSchema,
    offerId: IdentifierSchema,
    operationId: IdentifierSchema,
    paymentId: IdentifierSchema,
    txSignature: Base58Schema,
    resourceUrl: z.string().url(),
    state: z.literal("active"),
    activatedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

const HealthProbeCaptureSchema = z
  .object({
    healthy: z.literal(true),
    observedAt: TimestampSchema,
    routeActivationId: z.string().min(1).max(128),
    statusCode: z.number().int().min(200).max(299),
    latencyMs: z.number().finite().nonnegative().max(3_600_000),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();

const RecoveredResultSchema = z
  .object({
    outcome: z.literal("recovered"),
    correlationId: IdentifierSchema,
    transactionCreated: z.literal(true),
    txSignature: Base58Schema,
    reservationId: IdentifierSchema,
    incident: IncidentSchema,
    decision: RecoveryDecisionSchema,
    geminiBaseline: LiveGeminiDecisionRunCaptureSchema,
    offers: z.tuple([SignedOfferSchema, SignedOfferSchema]),
    selectedOffer: SignedOfferSchema,
    challengeHash: Sha256Schema,
    requestFingerprint: Sha256Schema,
    paymentRequiredHeader: z.string().min(8).max(512 * 1024),
    paymentSignatureHeader: z.string().min(8).max(512 * 1024),
    paymentResponseHeader: z.string().min(8).max(512 * 1024),
    signedTransactionSha256: Sha256Schema,
    resource: RecoveryResourceSchema,
    resourceResponseHash: Sha256Schema,
    fulfillmentReceipt: FulfillmentReceiptSchema,
    fulfillmentReceiptHash: Sha256Schema,
    healthProbe: HealthProbeCaptureSchema,
    healthProbeHash: Sha256Schema,
    recoveryOutcome: RecoveryOutcomeEnvelopeSchema,
    policyEvidence: PolicyReservationCaptureSchema,
    events: z.array(EventSchema).min(12),
    evidence: z
      .object({
        level: z.literal("live-unverified"),
        explorerUrl: z.null(),
        tokenDeltas: z.tuple([]),
      })
      .strict(),
  })
  .passthrough();

const DeniedResultSchema = z
  .object({
    outcome: z.literal("denied"),
    correlationId: IdentifierSchema,
    reasonCode: z.string().min(1).max(128),
    transactionCreated: z.literal(false),
    txSignature: z.null(),
    incident: IncidentSchema,
    decision: RecoveryDecisionSchema,
    geminiBaseline: LiveGeminiDecisionRunCaptureSchema,
    selectedOffer: SignedOfferSchema,
    events: z.array(EventSchema).min(1),
    evidence: z
      .object({
        level: z.literal("live-unverified"),
        explorerUrl: z.null(),
        tokenDeltas: z.tuple([]),
      })
      .strict(),
  })
  .passthrough();

const RecoveredCaptureSchema = z
  .object({
    request: CapturedRequestSchema,
    result: RecoveredResultSchema,
  })
  .strict();

export const NoPaymentDenialCaptureSchema = z
  .object({
    request: CapturedRequestSchema,
    result: DeniedResultSchema,
    attemptedAt: TimestampSchema,
    perTransactionLimitBaseUnits: z.string().regex(POSITIVE_INTEGER),
    replayProof: z
      .object({
        denialBinding: z
          .object({
            identifierType: z.enum(["nonce", "idempotencyKey", "paymentId"]),
            mandateId: IdentifierSchema,
            originalPaymentId: IdentifierSchema,
            deniedPaymentId: IdentifierSchema,
            originalIncidentId: IdentifierSchema,
            deniedIncidentId: IdentifierSchema,
            originalNonce: IdentifierSchema,
            deniedNonce: IdentifierSchema,
            originalIdempotencyKey: IdentifierSchema,
            deniedIdempotencyKey: IdentifierSchema,
            reasonCode: z.enum([
              "identifier.nonce_fresh",
              "identifier.idempotency_key_fresh",
              "identifier.payment_id_fresh",
            ]),
            transactionCreated: z.literal(false),
            txSignature: z.null(),
          })
          .strict(),
        denialBindingHash: Sha256Schema,
        originalTxSignature: Base58Schema,
        originalExplorerUrl: z.string().url().startsWith("https://"),
      })
      .strict()
      .optional(),
  })
  .strict();

export const AutomaticDenialCapturesSchema = z
  .object({
    overTransactionLimit: NoPaymentDenialCaptureSchema.refine(
      (value) => value.replayProof === undefined,
      { message: "Over-cap denial capture must not contain replayProof" },
    ),
    replay: NoPaymentDenialCaptureSchema.refine(
      (value) =>
        value.replayProof?.denialBinding.identifierType === "nonce" ||
        value.replayProof?.denialBinding.identifierType === "idempotencyKey",
      { message: "Replay denial capture must prove nonce or idempotency-key reuse" },
    ),
  })
  .strict();

export const VerifiedSettlementCaptureSchema = z
  .object({
    verification: z.literal("verified"),
    clusterLabel: z.literal("devnet"),
    genesisHash: z.literal(DEVNET_GENESIS_HASH),
    network: z.literal(DEVNET_X402_NETWORK_ID),
    assetMint: z.literal(DEVNET_USDC_MINT),
    decimals: z.literal(USDC_DECIMALS),
    amountBaseUnits: z.string().regex(POSITIVE_INTEGER),
    txSignature: Base58Schema,
    confirmationStatus: z.enum(["confirmed", "finalized"]),
    slot: z.number().int().nonnegative(),
    confirmedAt: TimestampSchema,
    payerOwner: Base58Schema,
    payeeOwner: Base58Schema,
    payerDeltaBaseUnits: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u),
    payeeDeltaBaseUnits: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u),
    tokenAccountDeltas: z
      .array(
        z
          .object({
            accountIndex: z.number().int().nonnegative(),
            tokenAccount: Base58Schema,
            owner: Base58Schema,
            mint: z.literal(DEVNET_USDC_MINT),
            decimals: z.literal(USDC_DECIMALS),
            preAmountBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
            postAmountBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
            deltaBaseUnits: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u),
          })
          .strict(),
      )
      .min(2),
    explorerUrl: z.string().url().startsWith("https://"),
  })
  .strict();

export const CapturedModelInputSchema = RecoveryDecisionModelInputSchema;
const SelectionRunCaptureSchema = LiveGeminiDecisionRunCaptureSchema;
export const GeminiSelectionPairCaptureSchema = LiveGeminiSelectionPairCaptureSchema;

export const LiveEvidencePromotionInputSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    recovered: RecoveredCaptureSchema.optional(),
    settlement: VerifiedSettlementCaptureSchema.optional(),
    offers: z.array(SignedOfferSchema).min(2).optional(),
    selection: GeminiSelectionPairCaptureSchema.optional(),
    denials: AutomaticDenialCapturesSchema.optional(),
    project: ProjectSchema.optional(),
    attestations: AttestationsSchema.optional(),
  })
  .strict();

export type LiveEvidencePromotionInput = z.infer<typeof LiveEvidencePromotionInputSchema>;
export type GeminiSelectionPairCapture = z.infer<typeof GeminiSelectionPairCaptureSchema>;

const FRAGMENT_KEYS = [
  "recovered",
  "settlement",
  "offers",
  "selection",
  "denials",
  "project",
  "attestations",
] as const;

type FragmentKey = (typeof FRAGMENT_KEYS)[number];

export type CapturePromotionResult =
  | Readonly<{
      promoted: false;
      missing: readonly FragmentKey[];
      fragmentPaths: readonly string[];
      finalEvidencePath: null;
    }>
  | Readonly<{
      promoted: true;
      missing: readonly [];
      fragmentPaths: readonly string[];
      finalEvidencePath: string;
      evidenceSha256: `sha256:${string}`;
    }>;

function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonBytes(value: unknown): Uint8Array {
  canonicalize(value);
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(
    dirname(path),
    `.${process.pid}.${randomBytes(12).toString("hex")}.${path.split("/").at(-1)}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await removeIfPresent(temporary);
    throw error;
  }
}

function assertNoSensitiveCaptureValue(value: unknown, path = "$capture"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveCaptureValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (
      /^(?:privateKey|secretKey|mnemonic|seed|seedPhrase|authorization|cookie|apiKey)$/iu.test(key)
    ) {
      throw new Error(`Signer material or credential field is forbidden in evidence capture: ${path}.${key}`);
    }
    assertNoSensitiveCaptureValue(item, `${path}.${key}`);
  }
}

function assertNoPlaceholderOrNonLiveMarker(value: unknown, path = "$evidence"): void {
  if (typeof value === "string") {
    if (/(?:^|[_:/.-])(?:placeholder|changeme|example|todo|tbd)(?:$|[_:/.-])/iu.test(value)) {
      throw new Error(`Placeholder-like value is forbidden in promoted evidence: ${path}`);
    }
    if (/^(?:fixture|local|mock|simulated|synthetic)$/iu.test(value.trim())) {
      throw new Error(`Non-live marker is forbidden in promoted evidence: ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPlaceholderOrNonLiveMarker(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      assertNoPlaceholderOrNonLiveMarker(item, `${path}.${key}`);
    }
  }
}

async function writeRawFragment(
  root: string,
  kind: FragmentKey,
  payload: unknown,
  capturedAt: string,
): Promise<string> {
  assertNoSensitiveCaptureValue(payload);
  const wrapper = {
    schemaVersion: "1.0",
    kind,
    capturedAt,
    payloadHash: canonicalHash(payload),
    payload,
  } as const;
  const relativePath = `artifacts/live-capture/${kind}.raw.json`;
  await atomicWrite(resolve(root, relativePath), jsonBytes(wrapper));
  return relativePath;
}

function event(
  events: readonly z.infer<typeof EventSchema>[],
  kind: string,
): z.infer<typeof EventSchema> {
  const matches = events.filter((candidate) => candidate.kind === kind);
  if (matches.length !== 1) throw new Error(`Recovered flow must contain exactly one ${kind} event`);
  return matches[0]!;
}

function assertChronology(entries: readonly [string, string][]): void {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!;
    const current = entries[index]!;
    if (Date.parse(previous[1]) > Date.parse(current[1])) {
      throw new Error(`${current[0]} predates ${previous[0]}`);
    }
  }
}

function toUsdcDecimal(baseUnits: string): string {
  const amount = BigInt(baseUnits);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function scalarPolicyValue(value: z.infer<typeof PolicyValueSchema>): string | number | boolean | null {
  return Array.isArray(value) ? canonicalize(value) : value;
}

function stateSequence(capture: z.infer<typeof ReservationCaptureSchema>): [
  "reserved",
  "submitted",
  "confirmed",
  "fulfilled",
  "committed",
] {
  const material = capture.stateHistory
    .map((entry) => entry.state)
    .filter((state) => state !== "proposed");
  const expected = ["reserved", "submitted", "confirmed", "fulfilled", "committed"] as const;
  if (canonicalize(material) !== canonicalize(expected)) {
    throw new Error("Reservation history must be proposed? -> reserved -> submitted -> confirmed -> fulfilled -> committed");
  }
  assertChronology(capture.stateHistory.map((entry) => [entry.state, entry.at] as [string, string]));
  if (
    Date.parse(capture.createdAt) > Date.parse(capture.stateHistory[0]!.at) ||
    Date.parse(capture.updatedAt) !== Date.parse(capture.stateHistory.at(-1)!.at)
  ) {
    throw new Error("Reservation createdAt/updatedAt do not bind the authoritative state history");
  }
  return [...expected];
}

function selectionSummary(
  capture: GeminiSelectionPairCapture,
): Pick<EvidenceSelection, "candidateOfferIds" | "baseline" | "counterfactual"> {
  const summarize = (run: z.infer<typeof SelectionRunCaptureSchema>) => {
    let decoded: unknown;
    try {
      decoded = parseJsonRejectingDuplicateKeys(run.generation.rawText);
    } catch (error) {
      throw new TypeError(`Gemini output is not strict JSON: ${(error as Error).message}`);
    }
    const decision = RecoveryDecisionSchema.parse(decoded);
    if (canonicalize(decision) !== canonicalize(run.decision)) {
      throw new Error("Captured Gemini raw output differs from the validated decision");
    }
    const candidates = run.modelInput.offers.map((offer) => offer.offerId);
    if (!candidates.includes(decision.selectedOfferId)) {
      throw new Error("Gemini selection is not one of the supplied offer IDs");
    }
    return {
      telemetryHash: canonicalHash(run.modelInput.incident.sanitizedTelemetry),
      modelOutputHash: sha256Bytes(run.generation.rawText),
      selectedOfferId: decision.selectedOfferId,
      schemaValidated: true as const,
      capturedAt: run.capturedAt,
    };
  };
  const baseline = summarize(capture.baseline);
  const counterfactual = summarize(capture.counterfactual);
  if (new Set(capture.candidateOfferIds).size !== 2) {
    throw new Error("Selection capture requires two unique candidate offer IDs");
  }
  for (const run of [capture.baseline, capture.counterfactual]) {
    const inputIds = run.modelInput.offers.map((offer) => offer.offerId);
    if (canonicalize(inputIds) !== canonicalize(capture.candidateOfferIds)) {
      throw new Error("Baseline and counterfactual must receive the same ordered offer IDs");
    }
  }
  if (baseline.telemetryHash === counterfactual.telemetryHash) {
    throw new Error("Counterfactual sanitized telemetry must differ from baseline");
  }
  if (baseline.selectedOfferId === counterfactual.selectedOfferId) {
    throw new Error("Counterfactual Gemini call must select a different supplied offer ID");
  }
  return { candidateOfferIds: [...capture.candidateOfferIds], baseline, counterfactual };
}

async function repositoryFile(
  root: string,
  relativePath: string,
  expectedHash?: string,
): Promise<Uint8Array> {
  if (isAbsolute(relativePath)) throw new Error("Artifact path must be repository-relative");
  const rootReal = await realpath(root);
  const path = await realpath(resolve(root, relativePath));
  if (path !== rootReal && !path.startsWith(`${rootReal}${sep}`)) {
    throw new Error(`Artifact escapes repository: ${relativePath}`);
  }
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact is missing, empty, or too large: ${relativePath}`);
  }
  const bytes = await readFile(path);
  if (expectedHash && hashBytes(bytes) !== expectedHash) {
    throw new Error(`Artifact hash mismatch: ${relativePath}`);
  }
  return bytes;
}

async function jsonArtifact(
  root: string,
  relativePath: string,
  expectedHash: string,
): Promise<Record<string, unknown>> {
  const bytes = await repositoryFile(root, relativePath, expectedHash);
  const value = parseJsonRejectingDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`JSON artifact must be an object: ${relativePath}`);
  }
  return value as Record<string, unknown>;
}

function roleMembers(policy: Record<string, unknown>, role: string): Set<string> {
  const members = new Set<string>();
  if (!Array.isArray(policy.bindings)) return members;
  for (const candidate of policy.bindings) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const binding = candidate as Record<string, unknown>;
    if (binding.role !== role || !Array.isArray(binding.members)) continue;
    for (const member of binding.members) if (typeof member === "string") members.add(member);
  }
  return members;
}

async function validateDeploymentArtifacts(root: string, project: EvidenceProject): Promise<void> {
  await repositoryFile(root, project.deploymentArtifact);
  const projectIam = await jsonArtifact(
    root,
    project.projectIamPolicyArtifact,
    project.projectIamPolicyArtifactSha256,
  );
  if (
    !Array.isArray(projectIam.bindings) ||
    typeof projectIam.etag !== "string" ||
    !Number.isInteger(projectIam.version) ||
    Number(projectIam.version) < 1
  ) {
    throw new Error("Project IAM artifact is not a raw IAM export");
  }
  await repositoryFile(root, project.deckPdf);
  if (project.demoVideo) await repositoryFile(root, project.demoVideo);

  const services = new Map(project.services.map((service) => [service.role, service]));
  if (services.size !== 3) throw new Error("Project must bind three unique Cloud Run service roles");
  const control = services.get("control-plane")!;
  const executor = services.get("payment-executor")!;
  const vendor = services.get("vendor-agent")!;
  if (new Set(project.services.map((service) => service.serviceAccount)).size !== 3) {
    throw new Error("Cloud Run roles must use distinct service accounts");
  }
  if (new Set(project.services.map((service) => new URL(service.url).origin)).size !== 3) {
    throw new Error("Cloud Run roles must use distinct origins");
  }
  for (const service of project.services) {
    const url = new URL(service.url);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new Error(`${service.role} URL must be the exact public HTTPS Cloud Run origin`);
    }
  }
  if (
    new URL(project.liveUrl).origin !== new URL(control.url).origin ||
    !control.healthUrl ||
    !vendor.healthUrl
  ) {
    throw new Error("Judge-facing live URL and public health endpoints are incomplete");
  }
  for (const field of ["deploymentArtifact", "serviceDescribeArtifact", "iamPolicyArtifact"] as const) {
    if (new Set(project.services.map((service) => service[field])).size !== 3) {
      throw new Error(`Cloud Run roles must use distinct ${field} values`);
    }
  }
  if (
    project.projectIamPolicyArtifact === project.deploymentArtifact ||
    project.projectIamPolicyArtifact === project.deckPdf ||
    project.services.some((service) => [
      service.deploymentArtifact,
      service.serviceDescribeArtifact,
      service.iamPolicyArtifact,
      service.secretIamPolicyArtifact,
    ].includes(project.projectIamPolicyArtifact))
  ) {
    throw new Error("Project IAM export must be a distinct hash-bound artifact");
  }
  assertProjectIamBoundary(
    projectIam,
    project.services.map((service) => service.serviceAccount),
  );
  if (!control.public || !vendor.public || executor.public || executor.iamProtected !== true) {
    throw new Error("Cloud Run public/private boundary is not exact");
  }
  if (executor.audience !== executor.url || executor.healthUrl !== undefined) {
    throw new Error("Private executor must bind its exact audience and publish no health URL");
  }

  const policies = new Map<string, Record<string, unknown>>();
  for (const service of project.services) {
    const deployment = new TextDecoder().decode(await repositoryFile(root, service.deploymentArtifact));
    if (!deployment.includes(service.serviceAccount)) {
      throw new Error(`${service.role} deployment artifact does not bind its service account`);
    }
    const description = await jsonArtifact(
      root,
      service.serviceDescribeArtifact,
      service.serviceDescribeArtifactSha256,
    );
    const spec = description.spec as Record<string, unknown> | undefined;
    const metadata = description.metadata as Record<string, unknown> | undefined;
    const template = spec?.template as Record<string, unknown> | undefined;
    const templateSpec = template?.spec as Record<string, unknown> | undefined;
    const status = description.status as Record<string, unknown> | undefined;
    if (
      description.apiVersion !== "serving.knative.dev/v1" ||
      description.kind !== "Service" ||
      typeof metadata?.uid !== "string" ||
      metadata.uid.length < 16 ||
      !Number.isInteger(metadata.generation) ||
      Number(metadata.generation) <= 0 ||
      templateSpec?.serviceAccountName !== service.serviceAccount ||
      !isCloudRunOriginBound(description, service.url) ||
      status?.observedGeneration !== metadata?.generation ||
      !Array.isArray(status?.conditions) ||
      !status.conditions.some((item) => {
        if (typeof item !== "object" || item === null) return false;
        const condition = item as Record<string, unknown>;
        return condition.type === "Ready" && String(condition.status).toLowerCase() === "true";
      })
    ) {
      throw new Error(`${service.role} description is not a ready raw Cloud Run service export`);
    }
    const iam = await jsonArtifact(root, service.iamPolicyArtifact, service.iamPolicyArtifactSha256);
    if (
      !Array.isArray(iam.bindings) ||
      typeof iam.etag !== "string" ||
      !Number.isInteger(iam.version) ||
      Number(iam.version) < 1
    ) {
      throw new Error(`${service.role} IAM artifact is not a raw IAM export`);
    }
    policies.set(service.role, iam);
  }
  if (!roleMembers(policies.get("control-plane")!, "roles/run.invoker").has("allUsers")) {
    throw new Error("Control-plane IAM does not permit public judge access");
  }
  if (!roleMembers(policies.get("vendor-agent")!, "roles/run.invoker").has("allUsers")) {
    throw new Error("Vendor IAM does not permit public A2A/x402 access");
  }
  const executorInvokers = roleMembers(policies.get("payment-executor")!, "roles/run.invoker");
  if (
    executorInvokers.size !== 1 ||
    !executorInvokers.has(`serviceAccount:${control.serviceAccount}`)
  ) {
    throw new Error("Executor run.invoker must be exclusive to the control-plane identity");
  }
  if (!executor.signerSecretResource || !executor.secretIamPolicyArtifact || !executor.secretIamPolicyArtifactSha256) {
    throw new Error("Executor signer secret evidence is incomplete");
  }
  if (project.services.some((service) => service.iamPolicyArtifact === executor.secretIamPolicyArtifact)) {
    throw new Error("Signer secret IAM export must be distinct from service IAM exports");
  }
  if (!/^projects\/[a-z][a-z0-9-]{4,62}\/secrets\/[A-Za-z0-9_-]+\/versions\/[0-9]+$/u.test(executor.signerSecretResource)) {
    throw new Error("Executor signer secret resource must pin an immutable numeric version");
  }
  const secretIam = await jsonArtifact(
    root,
    executor.secretIamPolicyArtifact,
    executor.secretIamPolicyArtifactSha256,
  );
  const accessors = roleMembers(secretIam, "roles/secretmanager.secretAccessor");
  if (
    !Array.isArray(secretIam.bindings) ||
    typeof secretIam.etag !== "string" ||
    !Number.isInteger(secretIam.version) ||
    Number(secretIam.version) < 1
  ) {
    throw new Error("Signer secret IAM artifact is not a raw IAM export");
  }
  if (
    accessors.size !== 1 ||
    !accessors.has(`serviceAccount:${executor.serviceAccount}`)
  ) {
    throw new Error("Signer secretAccessor must be exclusive to the executor identity");
  }
}

async function validateAttestationArtifacts(
  root: string,
  attestations: EvidenceAttestations,
): Promise<void> {
  for (const attestation of Object.values(attestations)) {
    for (const sourcePath of attestation.sourcePaths) await repositoryFile(root, sourcePath);
    await repositoryFile(root, attestation.runtimeArtifact, attestation.runtimeArtifactSha256);
  }
  const a2a = await jsonArtifact(
    root,
    attestations.a2a.runtimeArtifact,
    attestations.a2a.runtimeArtifactSha256,
  );
  if (canonicalHash(a2a) !== attestations.a2a.agentCardHash) {
    throw new Error("A2A runtime artifact does not bind agentCardHash");
  }
  const methods = Array.isArray(a2a.verificationMethods) ? a2a.verificationMethods : [];
  if (!methods.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const method = item as Record<string, unknown>;
    return method.id === attestations.a2a.verificationKeyId &&
      method.publicKeyBase58 === attestations.a2a.verificationPublicKey;
  })) {
    throw new Error("A2A runtime artifact does not publish the pinned offer/receipt authority");
  }
  const policy = await jsonArtifact(
    root,
    attestations.policy.runtimeArtifact,
    attestations.policy.runtimeArtifactSha256,
  );
  if (canonicalHash(policy) !== attestations.policy.executionPolicyHash) {
    throw new Error("Policy runtime artifact does not bind executionPolicyHash");
  }
  const gemini = await jsonArtifact(
    root,
    attestations.gemini.runtimeArtifact,
    attestations.gemini.runtimeArtifactSha256,
  );
  if (gemini.model !== attestations.gemini.model) {
    throw new Error("Gemini runtime artifact model differs from its attestation");
  }
  const autonomy = await jsonArtifact(
    root,
    attestations.autonomy.runtimeArtifact,
    attestations.autonomy.runtimeArtifactSha256,
  );
  const autonomyMethods = Array.isArray(autonomy.verificationMethods) ? autonomy.verificationMethods : [];
  if (!autonomyMethods.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const method = item as Record<string, unknown>;
    return method.id === attestations.autonomy.verificationKeyId &&
      method.publicKeyBase58 === attestations.autonomy.verificationPublicKey;
  })) {
    throw new Error("Autonomy artifact does not publish the recovery-outcome authority");
  }
  if (
    attestations.a2a.verificationPublicKey === attestations.autonomy.verificationPublicKey ||
    attestations.a2a.verificationKeyId === attestations.autonomy.verificationKeyId
  ) {
    throw new Error("Vendor and recovery outcome signing authorities must be distinct");
  }
  assertNoPlaceholderOrNonLiveMarker({ a2a, policy, gemini, autonomy }, "$runtime");
}

function assertDenialCapture(
  denial: z.infer<typeof NoPaymentDenialCaptureSchema>,
  policyHash: string,
): void {
  const { request, result } = denial;
  if (request.incidentId !== result.incident.id) {
    throw new Error("Denial request identity binding is invalid");
  }
  if (request.executionPolicy.policyHash !== policyHash) {
    throw new Error("Denial does not bind the active execution policy");
  }
  if (
    result.decision.selectedOfferId !== result.selectedOffer.payload.offerId ||
    canonicalize(result.geminiBaseline.decision) !== canonicalize(result.decision) ||
    result.geminiBaseline.modelInput.incident.id !== result.incident.id ||
    canonicalHash(result.geminiBaseline.modelInput.incident.sanitizedTelemetry) !==
      canonicalHash(result.incident.sanitizedTelemetry)
  ) {
    throw new Error("Denial does not bind its actual Gemini decision and selected offer");
  }
  const selectedProjection = result.geminiBaseline.modelInput.offers.find(
    (offer) => offer.offerId === result.selectedOffer.payload.offerId,
  );
  if (
    !selectedProjection ||
    selectedProjection.capability !== result.selectedOffer.payload.capability ||
    selectedProjection.priceBaseUnits !== result.selectedOffer.payload.amountBaseUnits
  ) {
    throw new Error("Denial selected offer differs from the signed Gemini input projection");
  }
  for (let index = 0; index < result.events.length; index += 1) {
    if (
      result.events[index]!.sequence !== index + 1 ||
      result.events[index]!.correlationId !== result.correlationId
    ) {
      throw new Error("Denial event sequence/correlation binding is invalid");
    }
  }
  const attempted = BigInt(result.selectedOffer.payload.amountBaseUnits);
  const limit = BigInt(denial.perTransactionLimitBaseUnits);
  if (!denial.replayProof && attempted <= limit) {
    throw new Error("Over-cap denial must attempt an amount above the per-transaction cap");
  }
  if (!denial.replayProof && result.reasonCode !== "amount.per_transaction_limit") {
    throw new Error("Over-cap denial must identify the deterministic per-transaction rule");
  }
  if (denial.replayProof && attempted > limit) {
    throw new Error("Replay denial must isolate replay protection without also exceeding the cap");
  }
  const denialEvents = result.events.filter((candidate) => candidate.kind === "policy_denied");
  if (denialEvents.length !== 1 || denialEvents[0]!.transactionCreated || denialEvents[0]!.txSignature !== null) {
    throw new Error("Denial must contain exactly one pre-transaction policy_denied event");
  }
  if (
    denialEvents[0]!.occurredAt !== denial.attemptedAt ||
    denialEvents[0]!.details.reasonCode !== result.reasonCode ||
    denialEvents[0]!.details.transactionCreated !== false ||
    denialEvents[0]!.details.txSignature !== null
  ) {
    throw new Error("Denial event does not bind time, reason, and absence of a transaction");
  }
  if (result.events.some((candidate) =>
    candidate.transactionCreated ||
    candidate.txSignature !== null ||
    ["payment_payload_signed", "paid_retry_sent", "settlement_confirmed"].includes(candidate.kind)
  )) {
    throw new Error("Denied flow contains payment creation or settlement evidence");
  }
  if (denial.replayProof) {
    const binding = denial.replayProof.denialBinding;
    if (canonicalHash(binding) !== denial.replayProof.denialBindingHash) {
      throw new Error("Replay denialBindingHash does not bind the trigger guard fields");
    }
    if (
      binding.mandateId !== request.mandateId ||
      binding.deniedPaymentId !== request.paymentId ||
      binding.deniedIncidentId !== request.incidentId ||
      binding.deniedNonce !== request.nonce ||
      binding.deniedIdempotencyKey !== request.idempotencyKey ||
      binding.reasonCode !== result.reasonCode ||
      binding.transactionCreated ||
      binding.txSignature !== null
    ) {
      throw new Error("Replay denial trigger binding differs from the denied request/result");
    }
    const expectedReason = binding.identifierType === "paymentId"
      ? "identifier.payment_id_fresh"
      : binding.identifierType === "nonce"
        ? "identifier.nonce_fresh"
        : "identifier.idempotency_key_fresh";
    if (binding.reasonCode !== expectedReason) {
      throw new Error("Replay denial does not use the matching deterministic freshness rule");
    }
  }
}

async function verifyFinalCandidateLocally(input: {
  root: string;
  evidence: Evidence;
  settlement: VerifiedSolanaSettlement;
}): Promise<void> {
  const { evidence, settlement, root } = input;
  await validateDeploymentArtifacts(root, evidence.project);
  await validateAttestationArtifacts(root, evidence.attestations);
  const vendorService = evidence.project.services.find((service) => service.role === "vendor-agent")!;
  if (new URL(evidence.attestations.a2a.agentCardUrl).origin !== new URL(vendorService.url).origin) {
    throw new Error("A2A Agent Card does not cross the deployed vendor-agent origin");
  }

  const pins = {
    publicKey: evidence.attestations.a2a.verificationPublicKey,
    keyId: evidence.attestations.a2a.verificationKeyId,
    agentCardHash: evidence.attestations.a2a.agentCardHash,
  };
  for (const offer of evidence.offers) await verifyOfferEnvelopeForEvidence(offer, pins);

  const payment = evidence.payments[0]!;
  verifyMoneyExplorerAndPolicy(payment);
  const trace = verifyX402Trace(payment);
  const payerSignature = await validateExactSvmPayerSignature(trace.payment);
  const inspection = inspectExactSvmPaymentTransaction(trace.payment);
  if (payerSignature.payer !== payment.payer || inspection.payer !== payment.payer) {
    throw new Error("Captured payer is not the signer/token payer of the exact SVM payload");
  }
  if (
    settlement.txSignature !== payment.txSignature ||
    settlement.payerOwner !== payment.payer ||
    settlement.payeeOwner !== payment.payee ||
    settlement.amountBaseUnits !== payment.amountBaseUnits ||
    settlement.explorerUrl !== payment.explorerUrl ||
    settlement.confirmationStatus !== payment.confirmationStatus ||
    settlement.slot !== payment.chainEvidence.slot ||
    settlement.confirmedAt !== payment.confirmedAt ||
    canonicalize(settlement.tokenAccountDeltas) !== canonicalize(payment.chainEvidence.tokenAccountDeltas)
  ) {
    throw new Error("Independent settlement output differs from the promoted chain evidence");
  }
  if (
    BigInt(settlement.payerDeltaBaseUnits) !== -BigInt(payment.amountBaseUnits) ||
    BigInt(settlement.payeeDeltaBaseUnits) !== BigInt(payment.amountBaseUnits)
  ) {
    throw new Error("Independent settlement lacks exact negative payer and positive payee deltas");
  }

  const receipt = payment.fulfillmentReceipt;
  if (!(await verifyCanonicalEd25519Signature({
    payload: receipt.payload,
    payloadSchema: FulfillmentReceiptPayloadSchema,
    signerPublicKey: receipt.signer,
    signature: receipt.signature,
  }))) {
    throw new Error("Fulfillment receipt signature is invalid");
  }
  if (computeSignedEnvelopeHash(receipt) !== payment.fulfillmentReceiptHash) {
    throw new Error("Fulfillment receipt hash mismatch");
  }
  const outcome = payment.outcome;
  if (!(await verifyCanonicalEd25519Signature({
    payload: outcome.payload,
    payloadSchema: RecoveryOutcomePayloadSchema,
    signerPublicKey: outcome.signer,
    signature: outcome.signature,
  }))) {
    throw new Error("Recovery outcome signature is invalid");
  }
  if (
    receipt.signer !== evidence.attestations.a2a.verificationPublicKey ||
    receipt.keyId !== evidence.attestations.a2a.verificationKeyId ||
    outcome.signer !== evidence.attestations.autonomy.verificationPublicKey ||
    outcome.keyId !== evidence.attestations.autonomy.verificationKeyId
  ) {
    throw new Error("Receipt or outcome signature is not pinned to its runtime attestation");
  }
  const expectedReceiptBindings = {
    incidentId: payment.incidentId,
    paymentId: payment.paymentId,
    offerId: payment.offerId,
    executionPolicyHash: payment.executionPolicyHash,
    challengeHash: payment.challengeHash,
    requestFingerprint: payment.requestFingerprint,
    txSignature: payment.txSignature,
    resourceResponseHash: payment.resourceResponseHash,
    resourceUrl: payment.x402.request.resourceUrl,
    payer: payment.payer,
    payee: payment.payee,
    assetMint: payment.assetMint,
    amountBaseUnits: payment.amountBaseUnits,
  } as const;
  for (const [key, value] of Object.entries(expectedReceiptBindings)) {
    if (receipt.payload[key as keyof typeof expectedReceiptBindings] !== value) {
      throw new Error(`Fulfillment receipt does not bind ${key}`);
    }
  }
  if (
    outcome.payload.incidentId !== payment.incidentId ||
    outcome.payload.paymentId !== payment.paymentId ||
    outcome.payload.fulfillmentReceiptHash !== payment.fulfillmentReceiptHash ||
    outcome.payload.resourceResponseHash !== payment.resourceResponseHash ||
    outcome.payload.statusAfter !== "healthy"
  ) {
    throw new Error("Recovery outcome does not bind the paid fulfillment and healthy state");
  }
  const outcomeArtifact = await jsonArtifact(root, outcome.artifactPath, outcome.artifactSha256);
  for (const [key, value] of Object.entries(outcome.payload)) {
    if (canonicalize(outcomeArtifact[key]) !== canonicalize(value)) {
      throw new Error(`Recovery outcome artifact does not bind ${key}`);
    }
  }

  const selectionArtifact = await jsonArtifact(
    root,
    evidence.selection.artifactPath,
    evidence.selection.artifactSha256,
  );
  for (const key of ["candidateOfferIds", "baseline", "counterfactual"] as const) {
    if (canonicalize(selectionArtifact[key]) !== canonicalize(evidence.selection[key])) {
      throw new Error(`Selection artifact does not bind ${key}`);
    }
  }
  for (const denial of evidence.denials) {
    const configuredLimit = evidence.attestations.policy.enforcedLimits.perTransactionLimitBaseUnits;
    if (typeof configuredLimit !== "string") {
      throw new Error("Policy attestation lacks perTransactionLimitBaseUnits");
    }
    assertDenialSemantics(denial, configuredLimit, evidence.payments.map((candidate) => ({
      incidentId: candidate.incidentId,
      mandateId: candidate.mandateId,
      paymentId: candidate.paymentId,
      ...(candidate.nonce === undefined ? {} : { nonce: candidate.nonce }),
      amountBaseUnits: candidate.amountBaseUnits,
      idempotencyKey: candidate.idempotencyKey,
      txSignature: candidate.txSignature,
      explorerUrl: candidate.explorerUrl,
    })));
    const artifact = await jsonArtifact(root, denial.artifactPath, denial.artifactSha256);
    for (const key of [
      "incidentId",
      "mandateId",
      "reasonCode",
      "attemptedAmountBaseUnits",
      "perTransactionLimitBaseUnits",
      "executionPolicyHash",
      "transactionCreated",
      "txSignature",
      "replayProof",
    ] as const) {
      const artifactValue = artifact[key];
      const denialValue = denial[key];
      const differs = artifactValue === undefined || denialValue === undefined
        ? artifactValue !== denialValue
        : canonicalize(artifactValue) !== canonicalize(denialValue);
      if (differs) {
        throw new Error(`Denial artifact does not bind ${key}`);
      }
    }
  }
  assertP0DualDenialSet(evidence.denials);
}

function offerIds(offers: readonly z.infer<typeof SignedOfferSchema>[]): string[] {
  return offers.map((offer) => offer.payload.offerId);
}

async function buildFinalEvidence(input: {
  root: string;
  capturedAt: string;
  recovered: z.infer<typeof RecoveredCaptureSchema>;
  settlement: z.infer<typeof VerifiedSettlementCaptureSchema>;
  offers: readonly z.infer<typeof SignedOfferSchema>[];
  selection: GeminiSelectionPairCapture;
  denials: z.infer<typeof AutomaticDenialCapturesSchema>;
  project: EvidenceProject;
  attestations: EvidenceAttestations;
}): Promise<Evidence> {
  const { root, recovered, settlement, offers, selection, denials, project, attestations } = input;
  const request = recovered.request;
  const result = recovered.result;
  const policy = result.policyEvidence;
  if (request.executionPolicy.policyHash !== computeExecutionPolicyHash(request.executionPolicy)) {
    throw new Error("Recovered request executionPolicyHash is invalid");
  }
  if (request.executionPolicy.policyHash !== attestations.policy.executionPolicyHash) {
    throw new Error("Recovered request does not bind the attested execution policy");
  }
  if (
    request.incidentId !== result.incident.id ||
    request.paymentId !== result.fulfillmentReceipt.payload.paymentId ||
    request.operationId !== result.resource.operationId ||
    request.idempotencyKey !== result.reservationId
  ) {
    throw new Error("Recovered request/result identifiers do not bind");
  }
  if (canonicalize(result.offers) !== canonicalize(offers)) {
    throw new Error("Promoted signed offers differ from the envelopes received by runLiveIncident");
  }
  if (!offers.some((offer) => canonicalize(offer) === canonicalize(result.selectedOffer))) {
    throw new Error("Recovered selected offer is not one of the promoted signed envelopes");
  }
  for (let index = 0; index < result.events.length; index += 1) {
    const current = result.events[index]!;
    if (current.sequence !== index + 1) throw new Error("Live-flow event sequence is not contiguous");
    if (current.correlationId !== result.correlationId) {
      throw new Error("Live-flow correlation ID did not propagate through every event");
    }
    if (index > 0 && Date.parse(current.occurredAt) < Date.parse(result.events[index - 1]!.occurredAt)) {
      throw new Error("Live-flow event chronology is not monotonic");
    }
  }

  const summary = selectionSummary(selection);
  if (
    canonicalize(summary.candidateOfferIds) !== canonicalize(offerIds(offers)) ||
    summary.baseline.selectedOfferId !== result.selectedOffer.payload.offerId ||
    canonicalize(selection.baseline) !== canonicalize(result.geminiBaseline) ||
    canonicalize(selection.baseline.decision) !== canonicalize(result.decision) ||
    selection.baseline.modelInput.incident.id !== result.incident.id ||
    canonicalHash(selection.baseline.modelInput.incident.sanitizedTelemetry) !==
      canonicalHash(result.incident.sanitizedTelemetry)
  ) {
    throw new Error("Paid result does not bind the actual baseline Gemini call and signed offer set");
  }
  for (const run of [selection.baseline, selection.counterfactual]) {
    for (const projection of run.modelInput.offers) {
      const signed = offers.find((offer) => offer.payload.offerId === projection.offerId);
      if (
        !signed ||
        signed.payload.capability !== projection.capability ||
        signed.payload.amountBaseUnits !== projection.priceBaseUnits
      ) {
        throw new Error("Gemini model input projection changes signed offer ID/capability/amount");
      }
    }
  }
  if (
    selection.baseline.generation.requestedModel !== attestations.gemini.model ||
    selection.counterfactual.generation.requestedModel !== attestations.gemini.model
  ) {
    throw new Error("Gemini selection calls do not use the attested model ID");
  }

  const selectionArtifact = {
    ...summary,
    actualGeminiCalls: {
      baseline: selection.baseline,
      counterfactual: selection.counterfactual,
    },
  };
  const selectionArtifactPath = "artifacts/live-capture/gemini-selection-artifact.json";
  const selectionArtifactBytes = jsonBytes(selectionArtifact);
  await atomicWrite(resolve(root, selectionArtifactPath), selectionArtifactBytes);

  const outcomeArtifactPath = "artifacts/live-capture/recovery-outcome-artifact.json";
  const outcomeArtifactBytes = jsonBytes(result.recoveryOutcome.payload);
  await atomicWrite(resolve(root, outcomeArtifactPath), outcomeArtifactBytes);

  const evidenceDenials: EvidenceDenial[] = [];
  for (const [kind, denial] of [
    ["over-transaction-limit", denials.overTransactionLimit],
    ["replay", denials.replay],
  ] as const) {
    assertDenialCapture(denial, attestations.policy.executionPolicyHash);
    if (
      attestations.policy.enforcedLimits.perTransactionLimitBaseUnits !==
        denial.perTransactionLimitBaseUnits
    ) {
      throw new Error("Denial cap differs from the active policy attestation");
    }
    let finalReplayProof:
      | {
          identifierType: "nonce" | "idempotencyKey" | "paymentId";
          identifierValue: string;
          originalPaymentId: string;
          deniedPaymentId: string;
          originalIncidentId: string;
          deniedIncidentId: string;
          originalNonce: string;
          deniedNonce: string;
          originalIdempotencyKey: string;
          deniedIdempotencyKey: string;
          originalTxSignature: string;
          originalExplorerUrl: string;
        }
      | undefined;
    if (denial.replayProof) {
      const binding = denial.replayProof.denialBinding;
      if (
        binding.mandateId !== request.mandateId ||
        binding.originalPaymentId !== request.paymentId ||
        binding.originalIncidentId !== request.incidentId ||
        binding.originalNonce !== request.nonce ||
        binding.originalIdempotencyKey !== request.idempotencyKey ||
        denial.replayProof.originalTxSignature !== result.txSignature ||
        denial.replayProof.originalExplorerUrl !== settlement.explorerUrl
      ) {
        throw new Error(
          "Replay proof does not bind the original recovered request and Devnet transaction",
        );
      }
      if (binding.identifierType === "paymentId") {
        if (
          binding.deniedPaymentId !== binding.originalPaymentId ||
          binding.deniedNonce === binding.originalNonce ||
          binding.deniedIdempotencyKey === binding.originalIdempotencyKey
        ) {
          throw new Error(
            "Payment-ID replay must reuse paymentId while using fresh nonce and idempotency identifiers",
          );
        }
      } else if (binding.identifierType === "nonce") {
        if (
          binding.deniedNonce !== binding.originalNonce ||
          binding.deniedPaymentId === binding.originalPaymentId ||
          binding.deniedIdempotencyKey === binding.originalIdempotencyKey
        ) {
          throw new Error(
            "Nonce replay must reuse nonce while using fresh payment and idempotency identifiers",
          );
        }
      } else if (
        binding.deniedIdempotencyKey !== binding.originalIdempotencyKey ||
        binding.deniedPaymentId === binding.originalPaymentId ||
        binding.deniedNonce === binding.originalNonce
      ) {
        throw new Error(
          "Idempotency replay must reuse idempotencyKey while using fresh payment and nonce identifiers",
        );
      }
      finalReplayProof = {
        identifierType: binding.identifierType,
        identifierValue:
          binding.identifierType === "paymentId"
            ? binding.deniedPaymentId
            : binding.identifierType === "nonce"
              ? binding.deniedNonce
              : binding.deniedIdempotencyKey,
        originalPaymentId: binding.originalPaymentId,
        deniedPaymentId: binding.deniedPaymentId,
        originalIncidentId: binding.originalIncidentId,
        deniedIncidentId: binding.deniedIncidentId,
        originalNonce: binding.originalNonce,
        deniedNonce: binding.deniedNonce,
        originalIdempotencyKey: binding.originalIdempotencyKey,
        deniedIdempotencyKey: binding.deniedIdempotencyKey,
        originalTxSignature: denial.replayProof.originalTxSignature,
        originalExplorerUrl: denial.replayProof.originalExplorerUrl,
      };
    }
    const denialArtifactBody = {
      incidentId: denial.result.incident.id,
      mandateId: denial.request.mandateId,
      reasonCode: denial.result.reasonCode,
      attemptedAt: denial.attemptedAt,
      attemptedAmountBaseUnits: denial.result.selectedOffer.payload.amountBaseUnits,
      perTransactionLimitBaseUnits: denial.perTransactionLimitBaseUnits,
      executionPolicyHash: denial.request.executionPolicy.policyHash,
      transactionCreated: false,
      txSignature: null,
      ...(finalReplayProof ? { replayProof: finalReplayProof } : {}),
    } as const;
    const denialArtifactPath =
      `artifacts/live-capture/policy-denial-${kind}-artifact.json`;
    const denialArtifactBytes = jsonBytes(denialArtifactBody);
    await atomicWrite(resolve(root, denialArtifactPath), denialArtifactBytes);
    evidenceDenials.push(
      DenialSchema.parse({
        ...denialArtifactBody,
        artifactPath: denialArtifactPath,
        artifactSha256: hashBytes(denialArtifactBytes),
      }),
    );
  }

  const reservation = policy.reservation;
  if (
    reservation.reservationId !== result.reservationId ||
    reservation.incidentId !== result.incident.id ||
    reservation.mandateId !== request.mandateId ||
    reservation.paymentId !== request.paymentId ||
    reservation.nonce !== request.nonce ||
    reservation.idempotencyKey !== request.idempotencyKey ||
    reservation.requestFingerprint !== result.requestFingerprint ||
    reservation.amountBaseUnits !== result.selectedOffer.payload.amountBaseUnits ||
    reservation.txSignature !== result.txSignature ||
    reservation.fulfillmentReceiptHash !== result.fulfillmentReceiptHash
  ) {
    throw new Error("Authoritative committed reservation does not bind the recovered payment");
  }
  const policyAllowed = event(result.events, "policy_allowed");
  if (canonicalize(policyAllowed.details.checks) !== canonicalize(policy.rules)) {
    throw new Error("Policy capture rules differ from the executor checks shown in the live flow");
  }

  const selected = result.selectedOffer.payload;
  if (
    settlement.txSignature !== result.txSignature ||
    settlement.payerOwner !== request.executionPolicy.executorPublicKey ||
    settlement.payeeOwner !== selected.payee ||
    settlement.amountBaseUnits !== selected.amountBaseUnits ||
    settlement.assetMint !== selected.assetMint ||
    settlement.network !== selected.network ||
    settlement.payerOwner === settlement.payeeOwner
  ) {
    throw new Error("Independent Solana settlement does not bind the recovered signed offer");
  }
  if (
    selected.method !== "POST" ||
    selected.capability !== request.requiredCapability ||
    Date.parse(selected.expiresAt) < Date.parse(settlement.confirmedAt)
  ) {
    throw new Error("Selected signed offer method/capability/expiry is invalid for the paid execution");
  }

  if (
    canonicalHash(result.resource) !== result.resourceResponseHash ||
    canonicalHash(result.healthProbe) !== result.healthProbeHash ||
    result.healthProbe.routeActivationId !== result.resource.activationId ||
    result.resource.incidentId !== result.incident.id ||
    result.resource.offerId !== selected.offerId ||
    result.resource.paymentId !== request.paymentId ||
    result.resource.operationId !== request.operationId ||
    result.resource.txSignature !== result.txSignature ||
    result.resource.resourceUrl !== selected.resourceUrl
  ) {
    throw new Error("Paid recovery resource or independent health probe hash/binding is invalid");
  }

  const receiptPayload = result.fulfillmentReceipt.payload;
  if (
    receiptPayload.issuerAgentId !== selected.providerAgentId ||
    receiptPayload.incidentId !== result.incident.id ||
    receiptPayload.offerId !== selected.offerId ||
    receiptPayload.paymentId !== request.paymentId ||
    receiptPayload.executionPolicyHash !== request.executionPolicy.policyHash ||
    receiptPayload.challengeHash !== result.challengeHash ||
    receiptPayload.requestFingerprint !== result.requestFingerprint ||
    receiptPayload.txSignature !== result.txSignature ||
    receiptPayload.resourceResponseHash !== result.resourceResponseHash ||
    receiptPayload.resourceUrl !== selected.resourceUrl ||
    receiptPayload.payer !== settlement.payerOwner ||
    receiptPayload.payee !== settlement.payeeOwner ||
    receiptPayload.assetMint !== settlement.assetMint ||
    receiptPayload.amountBaseUnits !== settlement.amountBaseUnits ||
    computeSignedEnvelopeHash(result.fulfillmentReceipt) !== result.fulfillmentReceiptHash
  ) {
    throw new Error("Vendor fulfillment receipt does not bind offer/request/settlement/resource");
  }
  const outcomePayload = result.recoveryOutcome.payload;
  if (
    outcomePayload.incidentId !== result.incident.id ||
    outcomePayload.paymentId !== request.paymentId ||
    outcomePayload.fulfillmentReceiptHash !== result.fulfillmentReceiptHash ||
    outcomePayload.resourceResponseHash !== result.resourceResponseHash ||
    outcomePayload.statusBefore !== result.incident.healthBefore ||
    outcomePayload.statusAfter !== "healthy" ||
    outcomePayload.healthProbeHash !== result.healthProbeHash
  ) {
    throw new Error("Recovery outcome does not bind the verified receipt/resource/healthy probe");
  }
  assertChronology([
    ["confirmation", settlement.confirmedAt],
    ["resource activation", result.resource.activatedAt],
    ["vendor fulfillment", receiptPayload.fulfilledAt],
    ["healthy probe", result.healthProbe.observedAt],
    ["recovery outcome", outcomePayload.recoveredAt],
  ]);

  const body = {
    incidentId: result.incident.id,
    offerId: selected.offerId,
    operationId: request.operationId,
    paymentId: request.paymentId,
    executionPolicyHash: request.executionPolicy.policyHash,
  } as const;
  const canonicalBodyHash = sha256Bytes(new TextEncoder().encode(canonicalize(body)));
  const expectedFingerprint = createRequestFingerprint({
    method: "POST",
    resourceUrl: selected.resourceUrl,
    operationId: request.operationId,
    canonicalBodyHash,
    paymentId: request.paymentId,
    scheme: "exact",
    network: selected.network,
    assetMint: selected.assetMint,
    amountBaseUnits: selected.amountBaseUnits,
    payee: selected.payee,
  });
  if (expectedFingerprint !== result.requestFingerprint) {
    throw new Error("Recovered request fingerprint does not bind the exact paid request");
  }

  const challengeAt = event(result.events, "x402_402_received").occurredAt;
  const paymentAt = event(result.events, "payment_payload_signed").occurredAt;
  const settlementAt = event(result.events, "settlement_confirmed").occurredAt;
  const committedAt = event(result.events, "budget_committed").occurredAt;
  assertChronology([
    ["incident", result.incident.observedAt],
    ["402", challengeAt],
    ["automatic signature", paymentAt],
    ["confirmed 200", settlementAt],
    ["commit", committedAt],
  ]);
  if (
    Date.parse(input.capturedAt) < Date.parse(committedAt) ||
    Object.values(denials).some(
      (denial) => Date.parse(input.capturedAt) < Date.parse(denial.attemptedAt),
    )
  ) {
    throw new Error("Evidence capture timestamp predates a bound event");
  }

  const policyEvidence = PolicyEvidenceSchema.parse({
    decision: "allow",
    reservationId: reservation.reservationId,
    amountBaseUnits: reservation.amountBaseUnits,
    remainingBeforeBaseUnits: policy.remainingBeforeBaseUnits,
    remainingAfterReserveBaseUnits: policy.remainingAfterReserveBaseUnits,
    remainingAfterCommitBaseUnits: policy.remainingAfterCommitBaseUnits,
    reservationStateHistory: stateSequence(reservation),
    rules: policy.rules.map((rule) => ({
      rule: rule.rule,
      expected: scalarPolicyValue(rule.expected),
      actual: scalarPolicyValue(rule.actual),
      pass: true,
    })),
  });
  const evidenceSelection: EvidenceSelection = {
    ...summary,
    artifactPath: selectionArtifactPath,
    artifactSha256: hashBytes(selectionArtifactBytes),
  };
  const evidence = EvidenceSchema.parse({
    schemaVersion: "2.0",
    generatedAt: input.capturedAt,
    evidenceStatus: "devnet-verified",
    project,
    attestations,
    offers,
    selection: evidenceSelection,
    payments: [{
      incidentId: result.incident.id,
      incidentAt: result.incident.observedAt,
      mandateId: request.mandateId,
      paymentId: request.paymentId,
      nonce: request.nonce,
      runBindingHash: createIncidentRunBindingHash({
        incidentId: request.incidentId,
        mandateId: request.mandateId,
        operationId: request.operationId,
        paymentId: request.paymentId,
        nonce: request.nonce,
        idempotencyKey: request.idempotencyKey,
        executionPolicyHash: request.executionPolicy.policyHash,
      }),
      offerId: selected.offerId,
      idempotencyKey: request.idempotencyKey,
      network: settlement.network,
      cluster: settlement.clusterLabel,
      asset: "USDC",
      assetMint: settlement.assetMint,
      decimals: settlement.decimals,
      amount: toUsdcDecimal(settlement.amountBaseUnits),
      amountBaseUnits: settlement.amountBaseUnits,
      payer: settlement.payerOwner,
      payee: settlement.payeeOwner,
      txSignature: settlement.txSignature,
      explorerUrl: settlement.explorerUrl,
      confirmationStatus: settlement.confirmationStatus,
      confirmedAt: settlement.confirmedAt,
      resourceResponseHash: result.resourceResponseHash,
      executionPolicyHash: request.executionPolicy.policyHash,
      challengeHash: result.challengeHash,
      requestFingerprint: result.requestFingerprint,
      x402: {
        request: {
          method: "POST",
          resourceUrl: selected.resourceUrl,
          operationId: request.operationId,
          canonicalBodyHash,
        },
        challenge: {
          status: 402,
          headerName: "PAYMENT-REQUIRED",
          headerValue: result.paymentRequiredHeader,
          capturedAt: challengeAt,
        },
        payment: {
          headerName: "PAYMENT-SIGNATURE",
          headerValue: result.paymentSignatureHeader,
          signedTransactionSha256: result.signedTransactionSha256,
          capturedAt: paymentAt,
        },
        settlement: {
          status: 200,
          headerName: "PAYMENT-RESPONSE",
          headerValue: result.paymentResponseHeader,
          capturedAt: settlementAt,
        },
      },
      chainEvidence: {
        genesisHash: settlement.genesisHash,
        sdkNetworkId: DEVNET_SVM_SDK_NETWORK_ID,
        slot: settlement.slot,
        payerDeltaBaseUnits: settlement.payerDeltaBaseUnits,
        payeeDeltaBaseUnits: settlement.payeeDeltaBaseUnits,
        tokenAccountDeltas: settlement.tokenAccountDeltas,
      },
      policyEvidence,
      fulfillmentReceipt: result.fulfillmentReceipt,
      fulfillmentReceiptHash: result.fulfillmentReceiptHash,
      outcome: {
        ...result.recoveryOutcome,
        artifactPath: outcomeArtifactPath,
        artifactSha256: hashBytes(outcomeArtifactBytes),
      },
    }],
    denials: evidenceDenials,
  });
  assertNoSensitiveCaptureValue(evidence, "$evidence");
  assertNoPlaceholderOrNonLiveMarker(evidence, "$evidence");
  await verifyFinalCandidateLocally({ root, evidence, settlement });
  return evidence;
}

/**
 * Produces a storage-safe request binding from the live request. Raw telemetry,
 * credentials and signer material are intentionally absent from this type.
 */
export function captureRequestBinding(input: {
  incident: { id: string };
  requiredCapability: string;
  mandateId: string;
  subject: string;
  operationId: string;
  paymentId: string;
  nonce: string;
  idempotencyKey: string;
  executionPolicy: unknown;
}): CapturedLiveIncidentRequest {
  return CapturedRequestSchema.parse({
    incidentId: input.incident.id,
    requiredCapability: input.requiredCapability,
    mandateId: input.mandateId,
    subject: input.subject,
    operationId: input.operationId,
    paymentId: input.paymentId,
    nonce: input.nonce,
    idempotencyKey: input.idempotencyKey,
    executionPolicy: input.executionPolicy,
  });
}

export async function independentlyQuerySettlement(
  options: Parameters<typeof verifySolanaSettlement>[0],
): Promise<VerifiedSolanaSettlement> {
  return verifySolanaSettlement(options);
}

export function createNoPaymentDenialCapture(
  input: z.input<typeof NoPaymentDenialCaptureSchema>,
): z.output<typeof NoPaymentDenialCaptureSchema> {
  const parsed = NoPaymentDenialCaptureSchema.parse(input);
  assertDenialCapture(parsed, parsed.request.executionPolicy.policyHash);
  return parsed;
}

/** Converts the two denial results returned by the same guarded operator run
 * into one all-or-nothing promotion fragment. Event time and replay bindings
 * come from the live results; callers cannot substitute a synthetic denial. */
export function createAutomaticDenialCaptures(input: {
  operatorRequest: OperatorRunIncidentRequest;
  results: AutomaticDenialResults;
  bindings: AutomaticDenialBindings;
  bindingHashes: AutomaticDenialBindingHashes;
  originalTxSignature: string;
  originalExplorerUrl: string;
}): z.output<typeof AutomaticDenialCapturesSchema> {
  const requests = input.operatorRequest.denialRequests;
  if (!requests) {
    throw new Error("Operator run did not request the mandatory dual-denial proof");
  }
  const overTransactionLimit = DeniedResultSchema.parse(
    input.results.overTransactionLimit,
  );
  const replay = DeniedResultSchema.parse(input.results.replay);
  if (
    canonicalHash(input.bindings.overTransactionLimit) !==
      input.bindingHashes.overTransactionLimit ||
    canonicalHash(input.bindings.replay) !== input.bindingHashes.replay
  ) {
    throw new Error("Operator dual-denial binding hash mismatch");
  }
  if (
    input.bindings.overTransactionLimit.deniedPaymentId !==
      requests.overTransactionLimit.paymentId ||
    input.bindings.overTransactionLimit.deniedIncidentId !==
      requests.overTransactionLimit.incident.id ||
    input.bindings.overTransactionLimit.deniedNonce !==
      requests.overTransactionLimit.nonce ||
    input.bindings.overTransactionLimit.deniedIdempotencyKey !==
      requests.overTransactionLimit.idempotencyKey ||
    input.bindings.overTransactionLimit.selectedOfferId !==
      overTransactionLimit.selectedOffer.payload.offerId ||
    input.bindings.overTransactionLimit.attemptedAmountBaseUnits !==
      overTransactionLimit.selectedOffer.payload.amountBaseUnits
  ) {
    throw new Error("Over-cap denial binding differs from its live request/result");
  }
  if (
    input.bindings.replay.originalPaymentId !==
      input.operatorRequest.request.paymentId ||
    input.bindings.replay.originalNonce !== input.operatorRequest.request.nonce ||
    input.bindings.replay.deniedPaymentId !== requests.replay.paymentId ||
    input.bindings.replay.deniedNonce !== requests.replay.nonce ||
    input.bindings.replay.deniedIncidentId !== requests.replay.incident.id ||
    input.bindings.replay.deniedIdempotencyKey !== requests.replay.idempotencyKey
  ) {
    throw new Error("Nonce replay binding differs from its live request/result");
  }
  const perTransactionLimitBaseUnits =
    requests.expectedPerTransactionLimitBaseUnits;
  return AutomaticDenialCapturesSchema.parse({
    overTransactionLimit: {
      request: captureRequestBinding(requests.overTransactionLimit),
      result: overTransactionLimit,
      attemptedAt: event(overTransactionLimit.events, "policy_denied").occurredAt,
      perTransactionLimitBaseUnits,
    },
    replay: {
      request: captureRequestBinding(requests.replay),
      result: replay,
      attemptedAt: event(replay.events, "policy_denied").occurredAt,
      perTransactionLimitBaseUnits,
      replayProof: {
        denialBinding: input.bindings.replay,
        denialBindingHash: input.bindingHashes.replay,
        originalTxSignature: input.originalTxSignature,
        originalExplorerUrl: input.originalExplorerUrl,
      },
    },
  });
}

export type LiveGeminiDecisionRunner = RecoveryDecisionModel;

export type RecordedLiveGeminiCall = GeminiDecisionRunCapture;

/** Wrap the model passed to runLiveIncident so its one real baseline call is
 * captured at source. This avoids making a second, potentially different,
 * baseline call merely for evidence export. */
export function createLiveGeminiCallRecorder(
  delegate: LiveGeminiDecisionRunner,
  now: () => string = () => new Date().toISOString(),
): Readonly<{
  model: LiveGeminiDecisionRunner;
  read(): RecordedLiveGeminiCall;
}> {
  let recorded: RecordedLiveGeminiCall | undefined;
  const model: LiveGeminiDecisionRunner = {
    async generate(candidate) {
      if (recorded) throw new Error("Live Gemini recorder permits exactly one baseline call");
      recorded = SelectionRunCaptureSchema.parse(
        await runCapturedGeminiDecision({
          model: delegate,
          modelInput: candidate,
          now,
        }),
      );
      if (recorded.generation.mode !== "live-gemini") {
        throw new Error("Live Gemini recorder received a non-live generation");
      }
      return {
        mode: "live-gemini",
        provider: "google-genai",
        requestedModel: recorded.generation.requestedModel,
        modelVersion: recorded.generation.modelVersion,
        ...(recorded.generation.responseId === undefined
          ? {}
          : { responseId: recorded.generation.responseId }),
        rawText: recorded.generation.rawText,
      };
    },
  };
  return {
    model,
    read() {
      if (!recorded) throw new Error("Live Gemini baseline has not run yet");
      return structuredClone(recorded);
    },
  };
}

/** Adds one counterfactual call to a baseline recorded inside runLiveIncident. */
export async function captureCounterfactualGeminiSelection(input: {
  baseline: RecordedLiveGeminiCall;
  counterfactualModel: LiveGeminiDecisionRunner;
  candidateOfferIds: readonly [string, string];
  counterfactualInput: z.infer<typeof CapturedModelInputSchema>;
  now?: () => string;
}): Promise<GeminiSelectionPairCapture> {
  const capture = GeminiSelectionPairCaptureSchema.parse(
    await captureSharedCounterfactualGeminiSelection({
      baseline: input.baseline,
      model: input.counterfactualModel,
      candidateOfferIds: input.candidateOfferIds,
      counterfactualInput: input.counterfactualInput,
      ...(input.now === undefined ? {} : { now: input.now }),
      requireLive: true,
    }),
  );
  selectionSummary(capture);
  return capture;
}

/** Practical production collector: the paid run already contains its exact
 * baseline, so this performs only the single counterfactual Gemini call. */
export async function collectGeminiSelectionForRecoveredResult(input: {
  recoveredResult: z.infer<typeof RecoveredResultSchema>;
  model: LiveGeminiDecisionRunner;
  counterfactualInput: z.infer<typeof CapturedModelInputSchema>;
  now?: () => string;
}): Promise<GeminiSelectionPairCapture> {
  const recovered = RecoveredResultSchema.parse(input.recoveredResult);
  const candidateOfferIds = recovered.offers.map(
    (offer) => offer.payload.offerId,
  ) as [string, string];
  return captureCounterfactualGeminiSelection({
    baseline: recovered.geminiBaseline,
    counterfactualModel: input.model,
    candidateOfferIds,
    counterfactualInput: input.counterfactualInput,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

/** Builds the validated partial manifest that `evidence:capture` can merge
 * with independently collected settlement, denial, deployment, and attestation fragments. */
export function createRecoveredPromotionManifest(input: {
  request: CapturedLiveIncidentRequest;
  result: z.infer<typeof RecoveredResultSchema>;
  selection: GeminiSelectionPairCapture;
}): LiveEvidencePromotionInput {
  const recovered = RecoveredCaptureSchema.parse({
    request: input.request,
    result: input.result,
  });
  return LiveEvidencePromotionInputSchema.parse({
    schemaVersion: "1.0",
    recovered,
    offers: recovered.result.offers,
    selection: input.selection,
  });
}

/** Runs two real Gemini calls over the same offer projections and captures the
 * exact sanitized inputs and raw outputs. It never performs or authorizes a payment. */
export async function captureMaterialGeminiSelection(input: {
  model: LiveGeminiDecisionRunner;
  candidateOfferIds: readonly [string, string];
  baselineInput: z.infer<typeof CapturedModelInputSchema>;
  counterfactualInput: z.infer<typeof CapturedModelInputSchema>;
  now?: () => string;
}): Promise<GeminiSelectionPairCapture> {
  const now = input.now ?? (() => new Date().toISOString());
  const baseline = SelectionRunCaptureSchema.parse(
    await runCapturedGeminiDecision({
      model: input.model,
      modelInput: input.baselineInput,
      now,
    }),
  );
  const counterfactual = SelectionRunCaptureSchema.parse(
    await runCapturedGeminiDecision({
      model: input.model,
      modelInput: input.counterfactualInput,
      now,
    }),
  );
  const capture = GeminiSelectionPairCaptureSchema.parse(
    combineGeminiSelectionPair({
      candidateOfferIds: input.candidateOfferIds,
      baseline,
      counterfactual,
      requireLive: true,
    }),
  );
  selectionSummary(capture);
  return capture;
}

/**
 * Writes each validated input as a clearly labelled raw fragment. The final
 * evidence file is replaced atomically only after every actual fragment and
 * every local signature/hash/binding invariant succeeds.
 */
export async function captureOrPromoteLiveEvidence(options: {
  root?: string;
  input: unknown;
  now?: () => Date;
}): Promise<CapturePromotionResult> {
  const root = resolve(options.root ?? ROOT);
  const capturedAt = (options.now ?? (() => new Date()))().toISOString();
  const parsed = LiveEvidencePromotionInputSchema.parse(options.input);
  const fragmentPaths: string[] = [];
  for (const key of FRAGMENT_KEYS) {
    const payload = parsed[key];
    if (payload !== undefined) {
      fragmentPaths.push(await writeRawFragment(root, key, payload, capturedAt));
    }
  }
  const missing = FRAGMENT_KEYS.filter((key) => parsed[key] === undefined);
  if (missing.length > 0) {
    return { promoted: false, missing, fragmentPaths, finalEvidencePath: null };
  }

  const recovered = parsed.recovered!;
  const settlement = parsed.settlement!;
  const offers = parsed.offers!;
  const selection = parsed.selection!;
  const denials = parsed.denials!;
  const project = parsed.project!;
  const attestations = parsed.attestations!;
  const evidence = await buildFinalEvidence({
    root,
    capturedAt,
    recovered,
    settlement,
    offers,
    selection,
    denials,
    project,
    attestations,
  });
  const bytes = jsonBytes(evidence);
  const relativePath = "artifacts/payment-evidence.json";
  await atomicWrite(resolve(root, relativePath), bytes);
  return {
    promoted: true,
    missing: [],
    fragmentPaths,
    finalEvidencePath: relativePath,
    evidenceSha256: hashBytes(bytes),
  };
}

async function readManifest(path: string): Promise<unknown> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error("Capture manifest is missing, empty, or too large");
  }
  const bytes = await readFile(path);
  return parseJsonRejectingDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function parseCaptureManifestArgument(args: readonly string[]): string {
  const positional = args.filter((argument) => argument !== "--");
  if (positional.length !== 1 || !positional[0]) {
    throw new Error("Usage: pnpm evidence:capture -- <promotion-manifest.json>");
  }
  return positional[0];
}

async function main(): Promise<void> {
  const argument = parseCaptureManifestArgument(process.argv.slice(2));
  const result = await captureOrPromoteLiveEvidence({ input: await readManifest(resolve(argument)) });
  if (!result.promoted) {
    console.error(`Captured ${result.fragmentPaths.length} raw fragment(s); missing: ${result.missing.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  console.error(`Promoted ${result.finalEvidencePath} (${result.evidenceSha256})`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    console.error(`Live evidence capture failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
