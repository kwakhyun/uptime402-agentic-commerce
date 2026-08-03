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
  FulfillmentReceiptPayloadSchema,
  RecoveryOutcomePayloadSchema,
  SignedEnvelopeSchema,
  TimestampSchema,
  VendorOfferPayloadSchema,
  canonicalHash,
  canonicalize,
  createIncidentRunBindingHash,
  createRequestFingerprint,
  normalizeHttpsUrl,
  sha256Bytes,
} from "@uptime402/domain";
import {
  DEVNET_SVM_SDK_NETWORK_ID,
  StrictPaymentPayloadV2Schema,
  StrictPaymentRequiredV2Schema,
  StrictSettleResponseSchema,
  USDC_DECIMALS,
  callSolanaRpc,
  extractRequiredPaymentIdentifier,
  hashSignedEnvelope,
  inspectExactSvmPaymentTransaction,
  validateExactSvmPayerSignature,
  verifyFacilitatorCosignedSvmTransaction,
  verifyCanonicalEd25519Signature,
  verifySolanaSettlement,
  type JsonRpcOptions,
  type PaymentPayload,
  type PaymentRequired,
  type VerifiedSolanaSettlement,
} from "@uptime402/payments";
import bs58 from "bs58";
import { z } from "zod";

import { isCloudRunOriginBound } from "./cloud-run-evidence.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OFFICIAL_SECONDARY_RPC = "https://api.devnet.solana.com/";
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_REMOTE_JSON_BYTES = 1024 * 1024;
const SHA256_HEX = /^sha256:[0-9a-f]{64}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const SIGNED_INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const DECIMAL_USDC = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;
const SAFE_RELATIVE_PATH = z.string().min(1).max(512).refine((value) => !isAbsolute(value));
const Identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const PositiveInteger = z.string().regex(POSITIVE_INTEGER);
const SignedInteger = z.string().regex(SIGNED_INTEGER);
const Hash = z.string().regex(SHA256_HEX);
const HttpsUrl = z.string().url().refine((value) => value.startsWith("https://"));

export const EvidenceOfferPayloadSchema = VendorOfferPayloadSchema
  .extend({
    network: z.literal(DEVNET_X402_NETWORK_ID),
    assetMint: z.literal(DEVNET_USDC_MINT),
  })
  .strict();

export const SignedOfferSchema = SignedEnvelopeSchema(EvidenceOfferPayloadSchema);

const SelectionDecisionSchema = z
  .object({
    telemetryHash: Hash,
    modelOutputHash: Hash,
    selectedOfferId: Identifier,
    schemaValidated: z.literal(true),
    capturedAt: TimestampSchema,
  })
  .strict();

export const SelectionSchema = z
  .object({
    candidateOfferIds: z.array(Identifier).min(2),
    baseline: SelectionDecisionSchema,
    counterfactual: SelectionDecisionSchema,
    artifactPath: SAFE_RELATIVE_PATH,
    artifactSha256: Hash,
  })
  .strict();

const RuntimeAttestationBase = {
  implemented: z.literal(true),
  sourcePaths: z.array(SAFE_RELATIVE_PATH).min(1),
  runtimeArtifact: SAFE_RELATIVE_PATH,
  runtimeArtifactSha256: Hash,
} as const;

export const AttestationsSchema = z
  .object({
    gemini: z
      .object({
        ...RuntimeAttestationBase,
        model: z.string().min(1).max(256).refine((value) => value.toLowerCase().includes("gemini")),
      })
      .strict(),
    a2a: z
      .object({
        ...RuntimeAttestationBase,
        separateService: z.literal(true),
        agentCardUrl: HttpsUrl,
        verificationKeyId: z.string().min(1).max(256),
        verificationPublicKey: Base58Schema,
        agentCardHash: Hash,
      })
      .strict(),
    autonomy: z
      .object({
        ...RuntimeAttestationBase,
        humanApprovalPerPayment: z.literal(false),
        automaticSigning: z.literal(true),
        verificationKeyId: z.string().min(1).max(256),
        verificationPublicKey: Base58Schema,
      })
      .strict(),
    policy: z
      .object({
        ...RuntimeAttestationBase,
        deterministic: z.literal(true),
        enforcedLimits: z.record(z.string().min(1), z.union([z.string(), z.number().int(), z.boolean()])),
        executionPolicyHash: Hash,
      })
      .strict(),
  })
  .strict();

export const ServiceSchema = z
  .object({
    role: z.enum(["control-plane", "payment-executor", "vendor-agent"]),
    url: HttpsUrl,
    healthUrl: HttpsUrl.optional(),
    public: z.boolean(),
    iamProtected: z.boolean().optional(),
    audience: HttpsUrl.optional(),
    serviceAccount: z.string().email().refine((value) => value.endsWith(".iam.gserviceaccount.com")),
    deploymentArtifact: SAFE_RELATIVE_PATH,
    serviceDescribeArtifact: SAFE_RELATIVE_PATH,
    serviceDescribeArtifactSha256: Hash,
    iamPolicyArtifact: SAFE_RELATIVE_PATH,
    iamPolicyArtifactSha256: Hash,
    signerSecretResource: z.string().optional(),
    secretIamPolicyArtifact: SAFE_RELATIVE_PATH.optional(),
    secretIamPolicyArtifactSha256: Hash.optional(),
  })
  .strict();

export const ProjectSchema = z
  .object({
    name: z.literal("Uptime402").optional(),
    networkTarget: z.literal("Solana Devnet").optional(),
    assetTarget: z.literal("USDC").optional(),
    deployment: z.literal("live").optional(),
    liveUrl: HttpsUrl,
    deploymentArtifact: SAFE_RELATIVE_PATH,
    projectIamPolicyArtifact: SAFE_RELATIVE_PATH,
    projectIamPolicyArtifactSha256: Hash,
    deckPdf: SAFE_RELATIVE_PATH,
    demoVideo: SAFE_RELATIVE_PATH.optional(),
    demoVideoUrl: HttpsUrl.optional(),
    demoVideoDurationSeconds: z.number().int().min(1).max(180),
    services: z.array(ServiceSchema).length(3),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.demoVideo && !value.demoVideoUrl) {
      context.addIssue({ code: "custom", path: ["demoVideo"], message: "Final demo video or URL is required" });
    }
  });

const X402RequestSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    resourceUrl: HttpsUrl,
    operationId: Identifier,
    canonicalBodyHash: Hash,
  })
  .strict();

const HeaderCaptureSchema = z
  .object({
    headerName: z.string(),
    headerValue: z.string().min(8).max(512 * 1024),
    capturedAt: TimestampSchema,
  })
  .strict();

const X402Schema = z
  .object({
    request: X402RequestSchema,
    challenge: HeaderCaptureSchema.extend({ status: z.literal(402) }).strict(),
    payment: HeaderCaptureSchema.extend({ signedTransactionSha256: Hash }).strict(),
    settlement: HeaderCaptureSchema.extend({ status: z.literal(200) }).strict(),
  })
  .strict();

const TokenAccountDeltaSchema = z
  .object({
    accountIndex: z.number().int().nonnegative(),
    tokenAccount: Base58Schema,
    owner: Base58Schema,
    mint: z.literal(DEVNET_USDC_MINT),
    decimals: z.literal(USDC_DECIMALS),
    preAmountBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    postAmountBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    deltaBaseUnits: SignedInteger,
  })
  .strict();

const ChainEvidenceSchema = z
  .object({
    genesisHash: z.literal(DEVNET_GENESIS_HASH),
    sdkNetworkId: z.literal(DEVNET_SVM_SDK_NETWORK_ID),
    slot: z.number().int().nonnegative(),
    payerDeltaBaseUnits: SignedInteger,
    payeeDeltaBaseUnits: SignedInteger,
    tokenAccountDeltas: z.array(TokenAccountDeltaSchema).min(2),
  })
  .strict();

export const PolicyEvidenceSchema = z
  .object({
    decision: z.literal("allow"),
    reservationId: Identifier,
    amountBaseUnits: PositiveInteger,
    remainingBeforeBaseUnits: PositiveInteger,
    remainingAfterReserveBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    remainingAfterCommitBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    reservationStateHistory: z.tuple([
      z.literal("reserved"),
      z.literal("submitted"),
      z.literal("confirmed"),
      z.literal("fulfilled"),
      z.literal("committed"),
    ]),
    rules: z
      .array(
        z
          .object({
            rule: z.string().min(1).max(128),
            expected: z.union([z.string(), z.number(), z.boolean(), z.null()]),
            actual: z.union([z.string(), z.number(), z.boolean(), z.null()]),
            pass: z.literal(true),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const SignedReceiptSchema = SignedEnvelopeSchema(FulfillmentReceiptPayloadSchema);
const SignedOutcomeSchema = SignedEnvelopeSchema(RecoveryOutcomePayloadSchema)
  .extend({ artifactPath: SAFE_RELATIVE_PATH, artifactSha256: Hash })
  .strict();

const PaymentSchema = z
  .object({
    incidentId: Identifier,
    incidentAt: TimestampSchema,
    mandateId: Identifier,
    paymentId: Identifier,
    nonce: Identifier,
    runBindingHash: Hash,
    offerId: Identifier,
    idempotencyKey: Identifier,
    network: z.literal(DEVNET_X402_NETWORK_ID),
    cluster: z.literal("devnet"),
    asset: z.literal("USDC"),
    assetMint: z.literal(DEVNET_USDC_MINT),
    decimals: z.literal(USDC_DECIMALS),
    amount: z.string().regex(DECIMAL_USDC),
    amountBaseUnits: PositiveInteger,
    payer: Base58Schema,
    payee: Base58Schema,
    txSignature: Base58Schema,
    explorerUrl: HttpsUrl,
    confirmationStatus: z.enum(["confirmed", "finalized"]),
    confirmedAt: TimestampSchema,
    resourceResponseHash: Hash,
    executionPolicyHash: Hash,
    challengeHash: Hash,
    requestFingerprint: Hash,
    x402: X402Schema,
    chainEvidence: ChainEvidenceSchema,
    policyEvidence: PolicyEvidenceSchema,
    fulfillmentReceipt: SignedReceiptSchema,
    fulfillmentReceiptHash: Hash,
    outcome: SignedOutcomeSchema,
  })
  .strict();

export const DenialSchema = z
  .object({
    incidentId: Identifier,
    mandateId: Identifier,
    reasonCode: z.string().min(1).max(128),
    attemptedAt: TimestampSchema,
    attemptedAmountBaseUnits: PositiveInteger,
    perTransactionLimitBaseUnits: PositiveInteger,
    executionPolicyHash: Hash,
    transactionCreated: z.literal(false),
    txSignature: z.null(),
    replayProof: z
      .object({
        identifierType: z.enum(["nonce", "idempotencyKey", "paymentId"]),
        identifierValue: Identifier,
        originalPaymentId: Identifier,
        deniedPaymentId: Identifier,
        originalIncidentId: Identifier,
        deniedIncidentId: Identifier,
        originalNonce: Identifier,
        deniedNonce: Identifier,
        originalIdempotencyKey: Identifier,
        deniedIdempotencyKey: Identifier,
        originalTxSignature: Base58Schema,
        originalExplorerUrl: HttpsUrl,
      })
      .strict()
      .optional(),
    artifactPath: SAFE_RELATIVE_PATH,
    artifactSha256: Hash,
  })
  .strict();

export const EvidenceSchema = z
  .object({
    schemaVersion: z.literal("2.0"),
    generatedAt: TimestampSchema,
    evidenceStatus: z.literal("devnet-verified").optional(),
    project: ProjectSchema,
    attestations: AttestationsSchema,
    offers: z.array(SignedOfferSchema).min(2),
    selection: SelectionSchema,
    payments: z.array(PaymentSchema).min(1),
    denials: z.array(DenialSchema).length(2),
  })
  .strict();

export type EvidenceOfferPayload = z.infer<typeof EvidenceOfferPayloadSchema>;
export type EvidencePayment = z.infer<typeof PaymentSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type EvidenceAttestations = z.infer<typeof AttestationsSchema>;
export type EvidenceProject = z.infer<typeof ProjectSchema>;
export type EvidenceSelection = z.infer<typeof SelectionSchema>;
export type EvidenceDenial = z.infer<typeof DenialSchema>;

class DuplicateKeyJsonScanner {
  private index = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.value("$");
    this.whitespace();
    if (this.index !== this.source.length) throw new SyntaxError(`Unexpected JSON token at byte ${this.index}`);
  }

  private whitespace(): void {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private value(path: string): void {
    this.whitespace();
    const char = this.source[this.index];
    if (char === "{") return this.object(path);
    if (char === "[") return this.array(path);
    if (char === '"') {
      this.string();
      return;
    }
    const literal = this.source.slice(this.index);
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(literal);
    if (!match) throw new SyntaxError(`Invalid JSON value at byte ${this.index}`);
    this.index += match[0].length;
  }

  private object(path: string): void {
    this.index += 1;
    this.whitespace();
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return;
    }
    while (true) {
      this.whitespace();
      if (this.source[this.index] !== '"') throw new SyntaxError(`Expected object key at byte ${this.index}`);
      const key = this.string();
      if (keys.has(key)) throw new SyntaxError(`Duplicate JSON key at ${path}.${key}`);
      keys.add(key);
      this.whitespace();
      if (this.source[this.index] !== ":") throw new SyntaxError(`Expected colon at byte ${this.index}`);
      this.index += 1;
      this.value(`${path}.${key}`);
      this.whitespace();
      if (this.source[this.index] === "}") {
        this.index += 1;
        return;
      }
      if (this.source[this.index] !== ",") throw new SyntaxError(`Expected comma at byte ${this.index}`);
      this.index += 1;
    }
  }

  private array(path: string): void {
    this.index += 1;
    this.whitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return;
    }
    let item = 0;
    while (true) {
      this.value(`${path}[${item}]`);
      item += 1;
      this.whitespace();
      if (this.source[this.index] === "]") {
        this.index += 1;
        return;
      }
      if (this.source[this.index] !== ",") throw new SyntaxError(`Expected comma at byte ${this.index}`);
      this.index += 1;
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === '"') {
        this.index += 1;
        return JSON.parse(this.source.slice(start, this.index)) as string;
      }
      if (char === "\\") {
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === "u") {
          const hex = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError(`Invalid Unicode escape at byte ${this.index}`);
          this.index += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) throw new SyntaxError(`Invalid escape at byte ${this.index}`);
      }
      if ((char?.charCodeAt(0) ?? 0) < 0x20) throw new SyntaxError(`Control character in JSON string at byte ${this.index}`);
      this.index += 1;
    }
    throw new SyntaxError("Unterminated JSON string");
  }
}

export function parseJsonRejectingDuplicateKeys(source: string): unknown {
  new DuplicateKeyJsonScanner(source).scan();
  return JSON.parse(source) as unknown;
}

function sha256FileBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertTimestampOrder(entries: readonly [string, string][]): void {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!;
    const current = entries[index]!;
    if (Date.parse(previous[1]) > Date.parse(current[1])) {
      throw new Error(`Evidence chronology violation: ${previous[0]} occurs after ${current[0]}`);
    }
  }
}

function assertBase58ByteLength(value: string, length: number, label: string): void {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new TypeError(`${label} must be valid Base58`);
  }
  if (decoded.byteLength !== length) throw new TypeError(`${label} must decode to ${length} bytes`);
}

function amountToBaseUnits(amount: string): string {
  if (!DECIMAL_USDC.test(amount)) throw new TypeError("USDC amount must be a decimal string with at most six places");
  const [whole, fraction = ""] = amount.split(".");
  return (BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0")).toString();
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertNoPlaceholderValues(value: unknown, path = "$evidence"): void {
  if (
    typeof value === "string" &&
    /(?:^|[_:/.-])(?:placeholder|changeme|example|todo|tbd)(?:$|[_:/.-])/i.test(value)
  ) {
    throw new Error(`Placeholder-like evidence value at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPlaceholderValues(item, `${path}[${index}]`));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) assertNoPlaceholderValues(item, `${path}.${key}`);
  }
}

function assertNoNonLiveEvidenceMarker(value: unknown, label: string): void {
  if (typeof value === "string" && /^(?:fixture|local|mock|simulated|synthetic)$/i.test(value.trim())) {
    throw new Error(`${label} contains a non-live evidence marker`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoNonLiveEvidenceMarker(item, label);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) assertNoNonLiveEvidenceMarker(item, label);
  }
}

function decodeBase64Json(value: string, label: string): unknown {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || /[+/_-]/.test(value) && /[+/]/.test(value) && /[_-]/.test(value)) {
    throw new TypeError(`${label} must be one canonical Base64 alphabet without whitespace`);
  }
  const urlSafe = /[_-]/.test(value);
  const unpadded = value.replace(/=+$/, "");
  if (value.length % 4 === 1) throw new TypeError(`${label} has invalid Base64 length`);
  const standard = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  const bytes = Buffer.from(padded, "base64");
  const roundTripStandard = bytes.toString("base64").replace(/=+$/, "");
  const roundTrip = urlSafe
    ? roundTripStandard.replace(/\+/g, "-").replace(/\//g, "_")
    : roundTripStandard;
  if (roundTrip !== unpadded) throw new TypeError(`${label} is not canonical Base64`);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${label} is not UTF-8 JSON`);
  }
  return parseJsonRejectingDuplicateKeys(source);
}

async function resolveRepositoryFile(
  root: string,
  relativePath: string,
  maxBytes = MAX_ARTIFACT_BYTES,
): Promise<string> {
  if (isAbsolute(relativePath)) throw new TypeError("Evidence artifact paths must be repository-relative");
  const rootReal = await realpath(root);
  const candidate = await realpath(resolve(root, relativePath));
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}${sep}`)) {
    throw new TypeError(`Evidence artifact escapes the repository: ${relativePath}`);
  }
  const metadata = await stat(candidate);
  if (!metadata.isFile() || metadata.size > maxBytes) {
    throw new TypeError(`Evidence artifact is missing, not a file, or too large: ${relativePath}`);
  }
  return candidate;
}

async function readHashedArtifact(
  root: string,
  relativePath: string,
  expectedHash: string,
): Promise<Uint8Array> {
  const path = await resolveRepositoryFile(root, relativePath);
  const bytes = await readFile(path);
  if (sha256FileBytes(bytes) !== expectedHash) throw new Error(`Artifact hash mismatch: ${relativePath}`);
  return bytes;
}

async function readHashedJsonArtifact(
  root: string,
  relativePath: string,
  expectedHash: string,
): Promise<Record<string, unknown>> {
  const bytes = await readHashedArtifact(root, relativePath, expectedHash);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return exactRecord(parseJsonRejectingDuplicateKeys(text), relativePath);
}

async function assertSourcePaths(root: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) await resolveRepositoryFile(root, path);
}

function verificationMethodPinned(
  runtime: Record<string, unknown>,
  keyId: string,
  publicKey: string,
): boolean {
  return Array.isArray(runtime.verificationMethods) && runtime.verificationMethods.some((candidate) => {
    const method = typeof candidate === "object" && candidate !== null
      ? candidate as Record<string, unknown>
      : null;
    return method?.id === keyId && method.publicKeyBase58 === publicKey;
  });
}

export async function verifyOfferEnvelopeForEvidence(
  candidate: unknown,
  pins: Readonly<{ publicKey: string; keyId: string; agentCardHash: string }>,
): Promise<z.infer<typeof SignedOfferSchema>> {
  const envelope = SignedOfferSchema.parse(candidate);
  assertBase58ByteLength(envelope.signer, 32, "Offer signer");
  assertBase58ByteLength(envelope.signature, 64, "Offer signature");
  if (envelope.signer !== pins.publicKey || envelope.keyId !== pins.keyId) {
    throw new Error("Offer signer is not the pinned Agent Card verification method");
  }
  if (envelope.payload.providerAgentCardHash !== pins.agentCardHash) {
    throw new Error("Offer does not bind the pinned Agent Card hash");
  }
  if (envelope.signer === envelope.payload.payee) {
    throw new Error("Offer signing authority must differ from the USDC payee");
  }
  if (!(await verifyCanonicalEd25519Signature({
    payload: envelope.payload,
    payloadSchema: EvidenceOfferPayloadSchema,
    signerPublicKey: envelope.signer,
    signature: envelope.signature,
  }))) {
    throw new Error("Offer Ed25519 signature verification failed");
  }
  return envelope;
}

const X402BindingSchema = PaymentSchema.pick({
  incidentId: true,
  incidentAt: true,
  mandateId: true,
  paymentId: true,
  nonce: true,
  idempotencyKey: true,
  executionPolicyHash: true,
  runBindingHash: true,
  network: true,
  assetMint: true,
  amountBaseUnits: true,
  payer: true,
  payee: true,
  txSignature: true,
  confirmedAt: true,
  challengeHash: true,
  requestFingerprint: true,
  x402: true,
}).strip();

export type VerifiedX402Trace = Readonly<{
  challenge: PaymentRequired;
  payment: PaymentPayload;
  signedTransactionBytes: Uint8Array;
}>;

export function verifyX402Trace(candidate: unknown): VerifiedX402Trace {
  const payment = X402BindingSchema.parse(candidate);
  const { request, challenge, payment: signed, settlement } = payment.x402;
  if (challenge.headerName !== "PAYMENT-REQUIRED") throw new Error("402 must use PAYMENT-REQUIRED");
  if (signed.headerName !== "PAYMENT-SIGNATURE") throw new Error("Paid retry must use PAYMENT-SIGNATURE");
  if (settlement.headerName !== "PAYMENT-RESPONSE") throw new Error("200 must use PAYMENT-RESPONSE");

  const normalizedUrl = normalizeHttpsUrl(request.resourceUrl);
  if (normalizedUrl !== request.resourceUrl) throw new Error("Paid resource URL is not in canonical normalized form");

  const required = StrictPaymentRequiredV2Schema.parse(
    decodeBase64Json(challenge.headerValue, "PAYMENT-REQUIRED"),
  ) as PaymentRequired;
  const payload = StrictPaymentPayloadV2Schema.parse(
    decodeBase64Json(signed.headerValue, "PAYMENT-SIGNATURE"),
  ) as PaymentPayload;
  const response = StrictSettleResponseSchema.parse(
    decodeBase64Json(settlement.headerValue, "PAYMENT-RESPONSE"),
  );

  if (required.resource.url !== request.resourceUrl) throw new Error("402 resource URL does not bind the paid request");
  const matches = required.accepts.filter((requirement) =>
    requirement.scheme === "exact" &&
    requirement.network === payment.network &&
    requirement.asset === payment.assetMint &&
    requirement.amount === payment.amountBaseUnits &&
    requirement.payTo === payment.payee,
  );
  if (matches.length !== 1) throw new Error("402 must contain exactly one matching exact requirement");
  const selected = matches[0]!;
  if (canonicalize(payload.accepted) !== canonicalize(selected)) {
    throw new Error("PAYMENT-SIGNATURE does not bind the selected 402 requirement");
  }
  if (payload.resource && payload.resource.url !== request.resourceUrl) {
    throw new Error("PAYMENT-SIGNATURE resource differs from the original request");
  }
  if (extractRequiredPaymentIdentifier(payload, required) !== payment.paymentId) {
    throw new Error("x402 Payment Identifier does not bind paymentId");
  }
  if (canonicalHash(required) !== payment.challengeHash) throw new Error("challengeHash mismatch");

  const transaction = payload.payload.transaction;
  if (typeof transaction !== "string") throw new Error("SVM x402 payload has no signed transaction");
  let transactionBytes: Uint8Array;
  try {
    transactionBytes = Buffer.from(transaction, "base64");
  } catch {
    throw new TypeError("SVM signed transaction is not Base64");
  }
  if (transactionBytes.byteLength === 0 || Buffer.from(transactionBytes).toString("base64") !== transaction) {
    throw new TypeError("SVM signed transaction is not canonical Base64");
  }
  if (sha256Bytes(transactionBytes) !== signed.signedTransactionSha256) {
    throw new Error("signedTransactionSha256 mismatch");
  }

  const expectedFingerprint = createRequestFingerprint({
    method: request.method,
    resourceUrl: request.resourceUrl,
    operationId: request.operationId,
    canonicalBodyHash: request.canonicalBodyHash,
    paymentId: payment.paymentId,
    scheme: "exact",
    network: payment.network,
    assetMint: payment.assetMint,
    amountBaseUnits: payment.amountBaseUnits,
    payee: payment.payee,
  });
  if (expectedFingerprint !== payment.requestFingerprint) throw new Error("requestFingerprint mismatch");
  const expectedRunBindingHash = createIncidentRunBindingHash({
    incidentId: payment.incidentId,
    mandateId: payment.mandateId,
    operationId: request.operationId,
    paymentId: payment.paymentId,
    nonce: payment.nonce,
    idempotencyKey: payment.idempotencyKey,
    executionPolicyHash: payment.executionPolicyHash,
  });
  if (expectedRunBindingHash !== payment.runBindingHash) {
    throw new Error("runBindingHash mismatch");
  }

  if (
    response.success !== true ||
    response.transaction !== payment.txSignature ||
    response.network !== payment.network ||
    response.payer !== payment.payer ||
    response.amount !== undefined && response.amount !== payment.amountBaseUnits
  ) {
    throw new Error("PAYMENT-RESPONSE does not bind success, network, payer, amount, and transaction");
  }

  assertTimestampOrder([
    ["incident", payment.incidentAt],
    ["402", challenge.capturedAt],
    ["automatic signature", signed.capturedAt],
    ["settled 200", settlement.capturedAt],
  ]);
  const confirmedAt = Date.parse(payment.confirmedAt);
  if (
    confirmedAt < Date.parse(signed.capturedAt) - 10_000 ||
    confirmedAt > Date.parse(settlement.capturedAt) + 10_000
  ) {
    throw new Error("RPC confirmation time falls outside the paid retry/settlement window");
  }
  return { challenge: required, payment: payload, signedTransactionBytes: transactionBytes };
}

export function verifyMoneyExplorerAndPolicy(candidate: unknown): void {
  const payment = PaymentSchema.pick({
    amount: true,
    amountBaseUnits: true,
    payer: true,
    payee: true,
    txSignature: true,
    explorerUrl: true,
    policyEvidence: true,
  }).strip().parse(candidate);
  assertBase58ByteLength(payment.payer, 32, "Payer owner");
  assertBase58ByteLength(payment.payee, 32, "Payee owner");
  assertBase58ByteLength(payment.txSignature, 64, "Transaction signature");
  if (payment.payer === payment.payee) throw new Error("Payer and payee owners must be distinct");
  if (amountToBaseUnits(payment.amount) !== payment.amountBaseUnits) {
    throw new Error("USDC decimal amount does not equal amountBaseUnits");
  }

  const explorer = new URL(payment.explorerUrl);
  const expectedPath = `/tx/${payment.txSignature}`;
  const expectedExplorerUrl = `https://explorer.solana.com${expectedPath}?cluster=devnet`;
  if (
    payment.explorerUrl !== expectedExplorerUrl ||
    explorer.protocol !== "https:" ||
    explorer.origin !== "https://explorer.solana.com" ||
    explorer.pathname !== expectedPath ||
    explorer.username || explorer.password || explorer.hash ||
    explorer.searchParams.size !== 1 || explorer.searchParams.get("cluster") !== "devnet"
  ) {
    throw new Error("Explorer URL must exactly bind the Devnet transaction signature");
  }

  const policy = payment.policyEvidence;
  const amount = BigInt(payment.amountBaseUnits);
  const before = BigInt(policy.remainingBeforeBaseUnits);
  if (policy.amountBaseUnits !== payment.amountBaseUnits || before < amount) {
    throw new Error("Policy reservation amount or available budget is incoherent");
  }
  const after = before - amount;
  if (
    BigInt(policy.remainingAfterReserveBaseUnits) !== after ||
    BigInt(policy.remainingAfterCommitBaseUnits) !== after
  ) {
    throw new Error("Policy reserve/commit budget math is incoherent");
  }
}

async function verifyOffersAndSelection(
  evidence: Evidence,
  root: string,
): Promise<Map<string, z.infer<typeof SignedOfferSchema>>> {
  const pins = {
    publicKey: evidence.attestations.a2a.verificationPublicKey,
    keyId: evidence.attestations.a2a.verificationKeyId,
    agentCardHash: evidence.attestations.a2a.agentCardHash,
  };
  const offers = new Map<string, z.infer<typeof SignedOfferSchema>>();
  for (const candidate of evidence.offers) {
    const offer = await verifyOfferEnvelopeForEvidence(candidate, pins);
    if (offers.has(offer.payload.offerId)) throw new Error(`Duplicate signed offerId: ${offer.payload.offerId}`);
    if (normalizeHttpsUrl(offer.payload.providerAgentCardUrl) !== offer.payload.providerAgentCardUrl) {
      throw new Error("Offer Agent Card URL is not canonical");
    }
    if (normalizeHttpsUrl(offer.payload.resourceUrl) !== offer.payload.resourceUrl) {
      throw new Error("Offer resource URL is not canonical");
    }
    if (offer.payload.providerAgentCardUrl !== evidence.attestations.a2a.agentCardUrl) {
      throw new Error("Offer Agent Card URL differs from the pinned A2A attestation");
    }
    offers.set(offer.payload.offerId, offer);
  }

  const selection = evidence.selection;
  if (new Set(selection.candidateOfferIds).size !== selection.candidateOfferIds.length) {
    throw new Error("Selection candidateOfferIds must be unique");
  }
  if (selection.candidateOfferIds.some((offerId) => !offers.has(offerId))) {
    throw new Error("Selection references an unverified signed offer");
  }
  for (const decision of [selection.baseline, selection.counterfactual]) {
    if (!selection.candidateOfferIds.includes(decision.selectedOfferId)) {
      throw new Error("Gemini selection must choose a supplied offerId");
    }
  }
  if (selection.baseline.telemetryHash === selection.counterfactual.telemetryHash) {
    throw new Error("Counterfactual telemetry must differ from baseline telemetry");
  }
  if (selection.baseline.selectedOfferId === selection.counterfactual.selectedOfferId) {
    throw new Error("Counterfactual telemetry must change selectedOfferId");
  }
  const selectionArtifact = await readHashedJsonArtifact(
    root,
    selection.artifactPath,
    selection.artifactSha256,
  );
  for (const key of ["candidateOfferIds", "baseline", "counterfactual"] as const) {
    if (canonicalize(selectionArtifact[key]) !== canonicalize(selection[key])) {
      throw new Error(`Selection artifact does not bind ${key}`);
    }
  }
  return offers;
}

async function verifyReceiptAndOutcome(
  payment: EvidencePayment,
  attestations: EvidenceAttestations,
  root: string,
): Promise<void> {
  const receipt = payment.fulfillmentReceipt;
  if (
    receipt.signer !== attestations.a2a.verificationPublicKey ||
    receipt.keyId !== attestations.a2a.verificationKeyId
  ) {
    throw new Error("Fulfillment receipt does not use the pinned vendor authority");
  }
  if (receipt.signer === payment.payee || receipt.signer === payment.payer) {
    throw new Error("Fulfillment receipt authority must differ from payment wallets");
  }
  const expectedReceipt = {
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
  for (const [key, value] of Object.entries(expectedReceipt)) {
    if (receipt.payload[key as keyof typeof expectedReceipt] !== value) {
      throw new Error(`Fulfillment receipt mutation or missing binding: ${key}`);
    }
  }
  if (!(await verifyCanonicalEd25519Signature({
    payload: receipt.payload,
    payloadSchema: FulfillmentReceiptPayloadSchema,
    signerPublicKey: receipt.signer,
    signature: receipt.signature,
  }))) {
    throw new Error("Fulfillment receipt Ed25519 signature verification failed");
  }
  if (hashSignedEnvelope(receipt) !== payment.fulfillmentReceiptHash) {
    throw new Error("fulfillmentReceiptHash mismatch");
  }

  const outcome = payment.outcome;
  if (
    outcome.signer !== attestations.autonomy.verificationPublicKey ||
    outcome.keyId !== attestations.autonomy.verificationKeyId
  ) {
    throw new Error("Recovery outcome does not use the pinned control-plane authority");
  }
  if (
    outcome.signer === receipt.signer || outcome.keyId === receipt.keyId ||
    outcome.signer === payment.payer || outcome.signer === payment.payee
  ) {
    throw new Error("Receipt, outcome, payer, and payee authorities must be separated");
  }
  const expectedOutcome = {
    incidentId: payment.incidentId,
    paymentId: payment.paymentId,
    fulfillmentReceiptHash: payment.fulfillmentReceiptHash,
    resourceResponseHash: payment.resourceResponseHash,
  } as const;
  for (const [key, value] of Object.entries(expectedOutcome)) {
    if (outcome.payload[key as keyof typeof expectedOutcome] !== value) {
      throw new Error(`Recovery outcome mutation or missing binding: ${key}`);
    }
  }
  if (!(await verifyCanonicalEd25519Signature({
    payload: outcome.payload,
    payloadSchema: RecoveryOutcomePayloadSchema,
    signerPublicKey: outcome.signer,
    signature: outcome.signature,
  }))) {
    throw new Error("Recovery outcome Ed25519 signature verification failed");
  }
  const outcomeArtifact = await readHashedJsonArtifact(root, outcome.artifactPath, outcome.artifactSha256);
  for (const [key, value] of Object.entries(outcome.payload)) {
    if (canonicalize(outcomeArtifact[key]) !== canonicalize(value)) {
      throw new Error(`Recovery outcome artifact does not bind ${key}`);
    }
  }
  assertTimestampOrder([
    ["independent chain confirmation", payment.confirmedAt],
    ["vendor fulfillment", receipt.payload.fulfilledAt],
    ["paid 200 response observed", payment.x402.settlement.capturedAt],
    ["healthy recovery", outcome.payload.recoveredAt],
  ]);
  if (Date.parse(payment.confirmedAt) > Date.parse(payment.x402.settlement.capturedAt) + 10_000) {
    throw new Error("Independent confirmation occurs implausibly after the paid response");
  }
}

async function verifyDenials(evidence: Evidence, root: string): Promise<void> {
  const configuredLimit = evidence.attestations.policy.enforcedLimits.perTransactionLimitBaseUnits;
  if (typeof configuredLimit !== "string" || !POSITIVE_INTEGER.test(configuredLimit)) {
    throw new Error("Policy attestation must expose perTransactionLimitBaseUnits as an integer string");
  }
  assertP0DualDenialSet(evidence.denials);
  for (const denial of evidence.denials) {
    assertDenialSemantics(
      denial,
      configuredLimit,
      evidence.payments.map((payment) => ({
        incidentId: payment.incidentId,
        mandateId: payment.mandateId,
        paymentId: payment.paymentId,
        ...(payment.nonce === undefined ? {} : { nonce: payment.nonce }),
        amountBaseUnits: payment.amountBaseUnits,
        idempotencyKey: payment.idempotencyKey,
        txSignature: payment.txSignature,
        explorerUrl: payment.explorerUrl,
      })),
    );
    if (denial.executionPolicyHash !== evidence.attestations.policy.executionPolicyHash) {
      throw new Error("Denial does not bind the active execution policy");
    }
    if (denial.perTransactionLimitBaseUnits !== configuredLimit) {
      throw new Error("Denial per-transaction limit differs from the policy attestation");
    }
    const artifact = await readHashedJsonArtifact(root, denial.artifactPath, denial.artifactSha256);
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
}

/** P0 requires two independent pre-transaction failures from the live path:
 * one amount-cap denial and one nonce/idempotency replay denial. */
export function assertP0DualDenialSet(
  denialCandidates: readonly unknown[],
): asserts denialCandidates is readonly EvidenceDenial[] {
  const denials = denialCandidates.map((candidate) => DenialSchema.parse(candidate));
  if (denials.length !== 2) {
    throw new Error("P0 evidence must contain exactly two denial records");
  }
  const overCap = denials.filter((denial) => denial.replayProof === undefined);
  const replay = denials.filter((denial) => denial.replayProof !== undefined);
  if (
    overCap.length !== 1 ||
    overCap[0]!.reasonCode !== "amount.per_transaction_limit"
  ) {
    throw new Error("P0 evidence must contain exactly one per-transaction over-cap denial");
  }
  if (
    replay.length !== 1 ||
    !["nonce", "idempotencyKey"].includes(
      String(replay[0]!.replayProof?.identifierType),
    )
  ) {
    throw new Error("P0 evidence must contain exactly one nonce or idempotency replay denial");
  }
  if (
    new Set(denials.map((denial) => denial.incidentId)).size !== 2 ||
    new Set(denials.map((denial) => denial.artifactPath)).size !== 2 ||
    denials.some(
      (denial) => denial.transactionCreated !== false || denial.txSignature !== null,
    )
  ) {
    throw new Error(
      "P0 denials must use distinct incidents/artifacts and create no transactions",
    );
  }
}

export type DenialOriginalPaymentBinding = Readonly<{
  incidentId: string;
  mandateId: string;
  paymentId: string;
  nonce?: string;
  amountBaseUnits: string;
  idempotencyKey: string;
  txSignature: string;
  explorerUrl: string;
}>;

/** Supports either an isolated over-cap denial or a strict replay denial tied
 * back to an already evidenced payment. Both paths prove no new transaction. */
export function assertDenialSemantics(
  denialCandidate: unknown,
  configuredPerTransactionLimit: string,
  originalPayments: readonly DenialOriginalPaymentBinding[],
): void {
  const denial = DenialSchema.parse(denialCandidate);
  if (!POSITIVE_INTEGER.test(configuredPerTransactionLimit)) {
    throw new TypeError("Configured denial limit must be a positive integer string");
  }
  if (denial.perTransactionLimitBaseUnits !== configuredPerTransactionLimit) {
    throw new Error("Denial per-transaction limit differs from the active policy");
  }
  const attempted = BigInt(denial.attemptedAmountBaseUnits);
  const limit = BigInt(denial.perTransactionLimitBaseUnits);
  if (!denial.replayProof) {
    if (attempted <= limit) throw new Error("Over-cap denial amount must exceed the per-transaction limit");
    if (denial.reasonCode !== "amount.per_transaction_limit") {
      throw new Error("Over-cap denial must bind amount.per_transaction_limit");
    }
    return;
  }
  if (attempted > limit) {
    throw new Error("Replay denial must isolate replay protection rather than also exceeding the cap");
  }
  const proof = denial.replayProof;
  const original = originalPayments.find((payment) => payment.paymentId === proof.originalPaymentId);
  if (!original) throw new Error("Replay denial does not reference an evidenced original payment");
  if (
    original.mandateId !== denial.mandateId ||
    original.incidentId !== proof.originalIncidentId ||
    denial.incidentId !== proof.deniedIncidentId ||
    original.nonce !== proof.originalNonce ||
    original.paymentId !== proof.originalPaymentId ||
    original.idempotencyKey !== proof.originalIdempotencyKey ||
    original.amountBaseUnits !== denial.attemptedAmountBaseUnits ||
    original.txSignature !== proof.originalTxSignature ||
    original.explorerUrl !== proof.originalExplorerUrl
  ) {
    throw new Error("Replay denial original mandate/amount/transaction binding is invalid");
  }
  const expectedExplorer = `https://explorer.solana.com/tx/${proof.originalTxSignature}?cluster=devnet`;
  if (proof.originalExplorerUrl !== expectedExplorer) {
    throw new Error("Replay denial original Explorer URL does not bind the Devnet transaction");
  }
  if (proof.identifierType === "paymentId") {
    if (
      denial.reasonCode !== "identifier.payment_id_fresh" ||
      proof.identifierValue !== original.paymentId ||
      proof.deniedPaymentId !== original.paymentId ||
      proof.deniedNonce === proof.originalNonce ||
      proof.deniedIdempotencyKey === proof.originalIdempotencyKey
    ) {
      throw new Error("Payment-ID replay denial does not bind the deterministic freshness rule");
    }
  } else if (proof.identifierType === "nonce") {
    if (
      denial.reasonCode !== "identifier.nonce_fresh" ||
      !original.nonce ||
      proof.identifierValue !== original.nonce ||
      proof.deniedNonce !== original.nonce ||
      proof.deniedPaymentId === original.paymentId ||
      proof.deniedIdempotencyKey === original.idempotencyKey
    ) {
      throw new Error("Nonce replay denial does not bind the deterministic freshness rule");
    }
  } else if (
    denial.reasonCode !== "identifier.idempotency_key_fresh" ||
    proof.identifierValue !== original.idempotencyKey ||
    proof.deniedIdempotencyKey !== original.idempotencyKey ||
    proof.deniedPaymentId === original.paymentId ||
    proof.deniedNonce === original.nonce
  ) {
    throw new Error(
      "Idempotency replay denial does not bind the deterministic freshness rule",
    );
  }
  if (proof.deniedIncidentId === proof.originalIncidentId) {
    throw new Error("Replay denial attempt must use a distinct incident");
  }
}

function assertGoldenCanonicalization(): void {
  const vector = {
    amountBaseUnits: "10000",
    method: "POST",
    nested: { z: 2, a: "한글" },
    values: [true, null, 0, 1.5],
  };
  const expected = '{"amountBaseUnits":"10000","method":"POST","nested":{"a":"한글","z":2},"values":[true,null,0,1.5]}';
  if (canonicalize(vector) !== expected) throw new Error("RFC 8785 canonicalization golden vector failed");
  if (canonicalHash(vector) !== sha256Bytes(new TextEncoder().encode(expected))) {
    throw new Error("RFC 8785 SHA-256 golden vector failed");
  }
  const normalized = normalizeHttpsUrl("https://Example.COM:443/a/../recover?z=2&a=1");
  if (normalized !== "https://example.com/recover?a=1&z=2") {
    throw new Error("URL normalization golden vector failed");
  }
}

type FetchLike = typeof fetch;

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new RangeError("Remote evidence response exceeds the byte limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RangeError("Remote evidence response exceeds the byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function fetchJsonNoRedirect(url: string, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Remote JSON evidence returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new TypeError("Remote evidence must use application/json");
  }
  const bytes = await readBoundedResponse(response, MAX_REMOTE_JSON_BYTES);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return exactRecord(parseJsonRejectingDuplicateKeys(source), "remote JSON evidence");
}

async function verifyAttestations(
  evidence: Evidence,
  root: string,
  fetchImpl: FetchLike,
): Promise<void> {
  const attestations = evidence.attestations;
  const runtimes = new Map<string, Record<string, unknown>>();
  for (const [name, attestation] of Object.entries(attestations)) {
    await assertSourcePaths(root, attestation.sourcePaths);
    runtimes.set(name, await readHashedJsonArtifact(
      root,
      attestation.runtimeArtifact,
      attestation.runtimeArtifactSha256,
    ));
  }

  const a2aRuntime = runtimes.get("a2a")!;
  if (canonicalHash(a2aRuntime) !== attestations.a2a.agentCardHash) {
    throw new Error("A2A runtime artifact does not match agentCardHash");
  }
  if (!verificationMethodPinned(
    a2aRuntime,
    attestations.a2a.verificationKeyId,
    attestations.a2a.verificationPublicKey,
  )) {
    throw new Error("A2A runtime artifact does not pin the vendor verification method");
  }

  const autonomyRuntime = runtimes.get("autonomy")!;
  if (!verificationMethodPinned(
    autonomyRuntime,
    attestations.autonomy.verificationKeyId,
    attestations.autonomy.verificationPublicKey,
  )) {
    throw new Error("Autonomy runtime artifact does not pin the recovery verification method");
  }
  if (
    attestations.a2a.verificationPublicKey === attestations.autonomy.verificationPublicKey ||
    attestations.a2a.verificationKeyId === attestations.autonomy.verificationKeyId
  ) {
    throw new Error("Vendor and control-plane signing authorities must be distinct");
  }

  const policyRuntime = runtimes.get("policy")!;
  if (Object.keys(attestations.policy.enforcedLimits).length === 0) {
    throw new Error("Deterministic policy attestation must enumerate enforced limits");
  }
  if (canonicalHash(policyRuntime) !== attestations.policy.executionPolicyHash) {
    throw new Error("executionPolicyHash does not bind the policy runtime artifact");
  }

  const geminiRuntime = runtimes.get("gemini")!;
  if (typeof geminiRuntime.model === "string" && geminiRuntime.model !== attestations.gemini.model) {
    throw new Error("Gemini runtime artifact model differs from its attestation");
  }
  for (const [name, runtime] of runtimes) assertNoNonLiveEvidenceMarker(runtime, `${name} runtime artifact`);

  const liveAgentCard = await fetchJsonNoRedirect(attestations.a2a.agentCardUrl, fetchImpl);
  if (canonicalHash(liveAgentCard) !== attestations.a2a.agentCardHash) {
    throw new Error("Live A2A Agent Card differs from its hash-bound runtime artifact");
  }
  if (!verificationMethodPinned(
    liveAgentCard,
    attestations.a2a.verificationKeyId,
    attestations.a2a.verificationPublicKey,
  )) {
    throw new Error("Live A2A Agent Card does not publish the pinned verification method");
  }
}

function roleMembers(policy: Record<string, unknown>, role: string): Set<string> {
  const members = new Set<string>();
  if (!Array.isArray(policy.bindings)) return members;
  for (const candidate of policy.bindings) {
    const binding = typeof candidate === "object" && candidate !== null
      ? candidate as Record<string, unknown>
      : null;
    if (binding?.role !== role || !Array.isArray(binding.members)) continue;
    for (const member of binding.members) if (typeof member === "string") members.add(member);
  }
  return members;
}

function hasRoleBinding(policy: Record<string, unknown>, role: string): boolean {
  return Array.isArray(policy.bindings) && policy.bindings.some((candidate) => {
    return typeof candidate === "object" && candidate !== null &&
      (candidate as Record<string, unknown>).role === role;
  });
}

function allRoleMembers(policy: Record<string, unknown>, role: string): Set<string> {
  const members = new Set<string>();
  if (!Array.isArray(policy.bindings)) return members;
  for (const candidate of policy.bindings) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const binding = candidate as Record<string, unknown>;
    if (binding.role !== role || !Array.isArray(binding.members)) continue;
    for (const member of binding.members) {
      if (typeof member === "string") members.add(member);
    }
  }
  return members;
}

function assertRawCloudRunDescription(
  description: Record<string, unknown>,
  service: z.infer<typeof ServiceSchema>,
): void {
  const metadata = exactRecord(description.metadata, "Cloud Run metadata");
  const spec = exactRecord(description.spec, "Cloud Run spec");
  const template = exactRecord(spec.template, "Cloud Run template");
  const templateSpec = exactRecord(template.spec, "Cloud Run template spec");
  const status = exactRecord(description.status, "Cloud Run status");
  if (
    description.apiVersion !== "serving.knative.dev/v1" ||
    description.kind !== "Service" ||
    typeof metadata.name !== "string" ||
    typeof metadata.namespace !== "string" ||
    typeof metadata.uid !== "string" || metadata.uid.length < 16 ||
    typeof metadata.creationTimestamp !== "string" || Number.isNaN(Date.parse(metadata.creationTimestamp)) ||
    !Number.isInteger(metadata.generation) || Number(metadata.generation) <= 0 ||
    status.observedGeneration !== metadata.generation ||
    !isCloudRunOriginBound(description, service.url) ||
    templateSpec.serviceAccountName !== service.serviceAccount ||
    typeof status.latestReadyRevisionName !== "string" ||
    !Array.isArray(status.conditions) ||
    !status.conditions.some((candidate) => {
      const condition = typeof candidate === "object" && candidate !== null
        ? candidate as Record<string, unknown>
        : null;
      return condition?.type === "Ready" &&
        String(condition.status).toLowerCase() === "true" &&
        typeof condition.lastTransitionTime === "string" &&
        !Number.isNaN(Date.parse(condition.lastTransitionTime));
    })
  ) {
    throw new Error(`Raw Cloud Run description does not bind ready service ${service.role}`);
  }
}

function assertRawIamPolicy(policy: Record<string, unknown>, label: string): void {
  if (
    !Array.isArray(policy.bindings) ||
    typeof policy.etag !== "string" || policy.etag.length < 4 ||
    !Number.isInteger(policy.version) || Number(policy.version) < 1
  ) {
    throw new Error(`${label} is not a raw IAM policy export`);
  }
}

export function assertProjectIamBoundary(
  candidate: unknown,
  runtimeServiceAccounts: readonly string[],
): void {
  const policy = exactRecord(candidate, "Project IAM artifact");
  assertRawIamPolicy(policy, "Project IAM artifact");
  for (const forbiddenRole of [
    "roles/run.invoker",
    "roles/secretmanager.secretAccessor",
  ]) {
    if (hasRoleBinding(policy, forbiddenRole)) {
      throw new Error(
        `Project IAM must not grant ${forbiddenRole}; bind it only on the exact service or secret`,
      );
    }
  }
  const runtimeIdentities = new Set(
    runtimeServiceAccounts.map((serviceAccount) => `serviceAccount:${serviceAccount}`),
  );
  for (const primitiveRole of ["roles/owner", "roles/editor"]) {
    if ([...allRoleMembers(policy, primitiveRole)].some((member) => runtimeIdentities.has(member))) {
      throw new Error(`Runtime service identities must not hold project-level ${primitiveRole}`);
    }
  }
}

async function verifyPublicEndpoint(url: string, fetchImpl: FetchLike): Promise<void> {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Public Cloud Run endpoint returned HTTP ${response.status}`);
}

async function verifyProjectBoundary(
  evidence: Evidence,
  root: string,
  fetchImpl: FetchLike,
): Promise<void> {
  const project = evidence.project;
  if (project.deployment !== "live") throw new Error("Only deployment=live evidence can produce a verification report");
  for (const url of [
    project.liveUrl,
    ...project.services.flatMap((service) => [service.url, ...(service.healthUrl ? [service.healthUrl] : [])]),
    evidence.attestations.a2a.agentCardUrl,
  ]) {
    const normalized = normalizeHttpsUrl(url);
    if (normalized !== url && normalized !== `${url}/`) {
      throw new Error(`Live service URL is not canonical public HTTPS: ${url}`);
    }
  }
  await resolveRepositoryFile(root, project.deploymentArtifact);
  const projectIamPolicy = await readHashedJsonArtifact(
    root,
    project.projectIamPolicyArtifact,
    project.projectIamPolicyArtifactSha256,
  );
  assertRawIamPolicy(projectIamPolicy, "Project IAM artifact");
  await resolveRepositoryFile(root, project.deckPdf);
  if (project.demoVideo) await resolveRepositoryFile(root, project.demoVideo, MAX_VIDEO_BYTES);

  const byRole = new Map(project.services.map((service) => [service.role, service]));
  if (byRole.size !== 3) throw new Error("Cloud Run services must have three unique roles");
  const control = byRole.get("control-plane")!;
  const executor = byRole.get("payment-executor")!;
  const vendor = byRole.get("vendor-agent")!;
  if (new Set(project.services.map((service) => new URL(service.url).origin)).size !== 3) {
    throw new Error("Control plane, executor, and vendor must use distinct service origins");
  }
  if (new Set(project.services.map((service) => service.serviceAccount)).size !== 3) {
    throw new Error("Cloud Run roles must use distinct service accounts");
  }
  if (
    new Set(project.services.map((service) => service.deploymentArtifact)).size !== 3 ||
    new Set(project.services.map((service) => service.serviceDescribeArtifact)).size !== 3 ||
    new Set(project.services.map((service) => service.iamPolicyArtifact)).size !== 3
  ) {
    throw new Error("Cloud Run roles must use distinct deployment, description, and IAM artifacts");
  }
  assertProjectIamBoundary(
    projectIamPolicy,
    project.services.map((service) => service.serviceAccount),
  );
  const projectArtifactPaths = new Set([
    project.deploymentArtifact,
    project.deckPdf,
    ...project.services.flatMap((service) => [
      service.deploymentArtifact,
      service.serviceDescribeArtifact,
      service.iamPolicyArtifact,
      ...(service.secretIamPolicyArtifact ? [service.secretIamPolicyArtifact] : []),
    ]),
  ]);
  if (projectArtifactPaths.has(project.projectIamPolicyArtifact)) {
    throw new Error("Project IAM export must be a distinct hash-bound artifact");
  }
  for (const service of project.services) {
    const serviceUrl = new URL(service.url);
    if (serviceUrl.pathname !== "/" || serviceUrl.search) {
      throw new Error(`${service.role} service URL must be its exact Cloud Run origin`);
    }
  }
  if (new URL(project.liveUrl).origin !== new URL(control.url).origin) {
    throw new Error("project.liveUrl must use the control-plane service origin");
  }
  if (new URL(evidence.attestations.a2a.agentCardUrl).origin !== new URL(vendor.url).origin) {
    throw new Error("A2A Agent Card must cross the vendor service origin");
  }
  if (!control.public || !vendor.public || executor.public || executor.iamProtected !== true) {
    throw new Error("Cloud Run public/private service boundary is incorrect");
  }
  if (executor.audience !== executor.url || executor.healthUrl !== undefined) {
    throw new Error("Private executor audience/health boundary is incorrect");
  }

  const iamPolicies = new Map<string, Record<string, unknown>>();
  for (const service of project.services) {
    const deploymentPath = await resolveRepositoryFile(root, service.deploymentArtifact);
    const deploymentText = new TextDecoder().decode(await readFile(deploymentPath));
    if (!deploymentText.includes(service.serviceAccount)) {
      throw new Error(`${service.role} deployment artifact does not bind its service account`);
    }
    const description = await readHashedJsonArtifact(
      root,
      service.serviceDescribeArtifact,
      service.serviceDescribeArtifactSha256,
    );
    assertRawCloudRunDescription(description, service);
    const iamPolicy = await readHashedJsonArtifact(
      root,
      service.iamPolicyArtifact,
      service.iamPolicyArtifactSha256,
    );
    assertRawIamPolicy(iamPolicy, `${service.role} IAM artifact`);
    iamPolicies.set(service.role, iamPolicy);
  }

  if (!roleMembers(iamPolicies.get("control-plane")!, "roles/run.invoker").has("allUsers")) {
    throw new Error("Control plane IAM does not allow judge-facing invocation");
  }
  if (!roleMembers(iamPolicies.get("vendor-agent")!, "roles/run.invoker").has("allUsers")) {
    throw new Error("Vendor IAM does not allow judge-facing invocation");
  }
  const executorInvokers = roleMembers(iamPolicies.get("payment-executor")!, "roles/run.invoker");
  const expectedInvoker = `serviceAccount:${control.serviceAccount}`;
  if (executorInvokers.size !== 1 || !executorInvokers.has(expectedInvoker)) {
    throw new Error("Executor IAM must grant run.invoker only to the control-plane identity");
  }

  if (
    !executor.signerSecretResource ||
    !/^projects\/[a-z][a-z0-9-]{4,62}\/secrets\/[A-Za-z0-9_-]+\/versions\/[0-9]+$/.test(executor.signerSecretResource) ||
    !executor.secretIamPolicyArtifact ||
    !executor.secretIamPolicyArtifactSha256
  ) {
    throw new Error("Executor signer secret must be version-pinned with hash-bound IAM evidence");
  }
  const secretIam = await readHashedJsonArtifact(
    root,
    executor.secretIamPolicyArtifact,
    executor.secretIamPolicyArtifactSha256,
  );
  if (project.services.some((service) => service.iamPolicyArtifact === executor.secretIamPolicyArtifact)) {
    throw new Error("Signer secret IAM export must be distinct from Cloud Run service IAM exports");
  }
  assertRawIamPolicy(secretIam, "Signer secret IAM artifact");
  const secretAccessors = roleMembers(secretIam, "roles/secretmanager.secretAccessor");
  const expectedAccessor = `serviceAccount:${executor.serviceAccount}`;
  if (
    secretAccessors.size !== 1 || !secretAccessors.has(expectedAccessor) ||
    secretAccessors.has(`serviceAccount:${control.serviceAccount}`) ||
    secretAccessors.has(`serviceAccount:${vendor.serviceAccount}`)
  ) {
    throw new Error("Signer secretAccessor must be exclusive to the executor service account");
  }

  if (!control.healthUrl || !vendor.healthUrl) throw new Error("Public Cloud Run services require health URLs");
  await verifyPublicEndpoint(project.liveUrl, fetchImpl);
  await verifyPublicEndpoint(control.healthUrl!, fetchImpl);
  await verifyPublicEndpoint(vendor.healthUrl!, fetchImpl);
  const unauthenticated = await fetchImpl(executor.url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  await unauthenticated.body?.cancel();
  if (unauthenticated.status !== 401 && unauthenticated.status !== 403) {
    throw new Error(`Unauthenticated executor invocation returned ${unauthenticated.status}, expected 401/403`);
  }
}

const RawTransactionSchema = z
  .object({
    slot: z.number().int().nonnegative(),
    transaction: z.tuple([z.string().min(1), z.string().min(1)]),
  })
  .passthrough()
  .nullable();

function validateRpcUrl(raw: string, label: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError(`${label} must be an HTTPS URL without userinfo or fragment`);
  }
  return url;
}

async function verifyPaymentAgainstRpc(
  payment: EvidencePayment,
  paymentPayload: PaymentPayload,
  rpcUrl: string,
  fetchImpl: FetchLike,
): Promise<VerifiedSolanaSettlement> {
  const rpc: JsonRpcOptions = { rpcUrl, fetchImpl, timeoutMs: 15_000 };
  const verified = await verifySolanaSettlement({
    rpc,
    txSignature: payment.txSignature,
    payerOwner: payment.payer,
    payeeOwner: payment.payee,
    amountBaseUnits: payment.amountBaseUnits,
    assetMint: DEVNET_USDC_MINT,
  });
  const raw = await callSolanaRpc(
    rpc,
    "getTransaction",
    [
      payment.txSignature,
      { commitment: "confirmed", encoding: "base64", maxSupportedTransactionVersion: 0 },
    ],
    RawTransactionSchema,
  );
  if (!raw || raw.slot !== verified.slot) throw new Error("RPC raw transaction is missing or has a mismatched slot");
  const rawBytes = Buffer.from(raw.transaction[0], "base64");
  if (
    rawBytes.byteLength === 0 ||
    rawBytes.toString("base64") !== raw.transaction[0]
  ) {
    throw new Error("Live RPC transaction is not canonical Base64");
  }
  const cosigned = await verifyFacilitatorCosignedSvmTransaction(
    paymentPayload,
    raw.transaction[0],
  );
  if (cosigned.payer !== payment.payer) {
    throw new Error("Live facilitator-cosigned transaction payer differs from evidence");
  }
  if (payment.confirmationStatus === "finalized" && verified.confirmationStatus !== "finalized") {
    throw new Error("Evidence claims finalized but RPC does not");
  }
  if (Math.abs(Date.parse(payment.confirmedAt) - Date.parse(verified.confirmedAt)) > 10 * 60 * 1_000) {
    throw new Error("Evidence confirmedAt is stale or inconsistent with RPC blockTime");
  }
  const recorded = payment.chainEvidence;
  if (
    recorded.genesisHash !== verified.genesisHash ||
    recorded.sdkNetworkId !== DEVNET_SVM_SDK_NETWORK_ID ||
    recorded.slot !== verified.slot ||
    recorded.payerDeltaBaseUnits !== verified.payerDeltaBaseUnits ||
    recorded.payeeDeltaBaseUnits !== verified.payeeDeltaBaseUnits ||
    canonicalize(recorded.tokenAccountDeltas) !== canonicalize(verified.tokenAccountDeltas)
  ) {
    throw new Error("Recorded token-account delta evidence differs from independent RPC verification");
  }
  if (
    BigInt(recorded.payerDeltaBaseUnits) !== -BigInt(payment.amountBaseUnits) ||
    BigInt(recorded.payeeDeltaBaseUnits) !== BigInt(payment.amountBaseUnits) ||
    !recorded.tokenAccountDeltas.some((delta) => delta.owner === payment.payer && BigInt(delta.deltaBaseUnits) < 0n) ||
    !recorded.tokenAccountDeltas.some((delta) => delta.owner === payment.payee && BigInt(delta.deltaBaseUnits) > 0n)
  ) {
    throw new Error("Evidence lacks matching negative payer and positive payee token-account deltas");
  }
  return verified;
}

export type VerifyEvidenceOptions = Readonly<{
  root?: string;
  evidencePath?: string;
  reportPath?: string;
  nonce: string;
  primaryRpcUrl: string;
  secondaryRpcUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
}>;

const REPORT_CHECKS = Object.freeze({
  geminiRuntime: true,
  a2aRemoteService: true,
  autonomousNoPrompt: true,
  policyAllow: true,
  policyDeny: true,
  recoveryOutcome: true,
  x402RoundTrip: true,
  offerSignature: true,
  fulfillmentReceiptSignature: true,
  cloudRunIdentityBoundary: true,
  executorUnauthenticatedDenied: true,
  signerSecretLeastPrivilege: true,
  urlCanonicalization: true,
} as const);

export type VerificationReport = Readonly<{
  schemaVersion: "1.0";
  nonce: string;
  producedAt: string;
  evidenceSha256: `sha256:${string}`;
  rpcHosts: Readonly<{ primary: string; secondary?: string }>;
  checks: typeof REPORT_CHECKS;
}>;

function assertVerificationNonce(nonce: string): void {
  if (
    !/^[A-Za-z0-9_-]{32,256}$/.test(nonce) ||
    /(?:placeholder|example|test[_-]?nonce|changeme)/i.test(nonce) ||
    new Set(nonce).size < 8
  ) {
    throw new TypeError("UPTIME402_VERIFICATION_NONCE must be an unpredictable 32-256 character value");
  }
}

async function safelyRemove(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWriteReport(path: string, report: VerificationReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(
    dirname(path),
    `.${process.pid}.${randomBytes(12).toString("hex")}.verification-report.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await safelyRemove(temporary);
    throw error;
  }
}

export async function verifyEvidence(options: VerifyEvidenceOptions): Promise<VerificationReport> {
  const root = resolve(options.root ?? ROOT);
  const evidencePath = resolve(options.evidencePath ?? resolve(root, "artifacts/payment-evidence.json"));
  const reportPath = resolve(options.reportPath ?? resolve(root, "artifacts/verification-report.json"));
  await safelyRemove(reportPath);
  assertVerificationNonce(options.nonce);

  const primary = validateRpcUrl(options.primaryRpcUrl, "SOLANA_RPC_URL");
  const secondary = options.secondaryRpcUrl
    ? validateRpcUrl(options.secondaryRpcUrl, "SOLANA_SECONDARY_RPC_URL")
    : undefined;
  if (secondary && secondary.toString() !== OFFICIAL_SECONDARY_RPC) {
    throw new TypeError(`Secondary verification RPC must be ${OFFICIAL_SECONDARY_RPC}`);
  }

  const evidenceBytes = await readFile(evidencePath);
  if (evidenceBytes.byteLength === 0 || evidenceBytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new TypeError("payment-evidence.json is empty or exceeds the evidence size limit");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(evidenceBytes);
  const parsed = parseJsonRejectingDuplicateKeys(source);
  const evidence = EvidenceSchema.parse(parsed);
  assertNoPlaceholderValues(evidence);
  if (evidence.evidenceStatus !== "devnet-verified") {
    throw new Error("Evidence must explicitly declare evidenceStatus=devnet-verified");
  }
  const now = (options.now ?? (() => new Date()))();
  if (Date.parse(evidence.generatedAt) > now.getTime() + 5 * 60 * 1_000) {
    throw new Error("Evidence generatedAt is in the future");
  }

  assertGoldenCanonicalization();
  const fetchImpl = options.fetchImpl ?? fetch;
  await verifyProjectBoundary(evidence, root, fetchImpl);
  await verifyAttestations(evidence, root, fetchImpl);
  const offers = await verifyOffersAndSelection(evidence, root);
  await verifyDenials(evidence, root);

  const seenPaymentIds = new Set<string>();
  const seenIdempotencyKeys = new Set<string>();
  const configuredPerTransactionLimit = evidence.attestations.policy.enforcedLimits.perTransactionLimitBaseUnits;
  if (typeof configuredPerTransactionLimit !== "string" || !POSITIVE_INTEGER.test(configuredPerTransactionLimit)) {
    throw new Error("Policy attestation lacks a valid perTransactionLimitBaseUnits value");
  }
  for (const payment of evidence.payments) {
    if (seenPaymentIds.has(payment.paymentId) || seenIdempotencyKeys.has(payment.idempotencyKey)) {
      throw new Error("Duplicate paymentId or idempotencyKey in final evidence");
    }
    seenPaymentIds.add(payment.paymentId);
    seenIdempotencyKeys.add(payment.idempotencyKey);
    verifyMoneyExplorerAndPolicy(payment);
    const x402Trace = verifyX402Trace(payment);
    const payerSignature = await validateExactSvmPayerSignature(x402Trace.payment);
    const transactionInspection = inspectExactSvmPaymentTransaction(x402Trace.payment);
    if (payerSignature.payer !== payment.payer || transactionInspection.payer !== payment.payer) {
      throw new Error("Recorded payer is not the valid token payer of the x402 SVM transaction");
    }
    const expectedFeePayer = x402Trace.payment.accepted.extra.feePayer;
    if (typeof expectedFeePayer !== "string" || transactionInspection.feePayer !== expectedFeePayer) {
      throw new Error("x402 transaction fee payer differs from the signed requirement");
    }
    if (payment.executionPolicyHash !== evidence.attestations.policy.executionPolicyHash) {
      throw new Error("Payment does not bind the active execution policy");
    }
    if (BigInt(payment.amountBaseUnits) > BigInt(configuredPerTransactionLimit)) {
      throw new Error("Policy allow evidence exceeds perTransactionLimitBaseUnits");
    }
    const offer = offers.get(payment.offerId);
    if (!offer || payment.offerId !== evidence.selection.baseline.selectedOfferId) {
      throw new Error("Paid offer must be the verified Gemini baseline selection");
    }
    const offerPayload = offer.payload;
    if (
      offerPayload.network !== payment.network ||
      offerPayload.asset !== payment.asset ||
      offerPayload.assetMint !== payment.assetMint ||
      offerPayload.amountBaseUnits !== payment.amountBaseUnits ||
      offerPayload.payee !== payment.payee ||
      offerPayload.resourceUrl !== payment.x402.request.resourceUrl ||
      offerPayload.method !== undefined && offerPayload.method !== payment.x402.request.method
    ) {
      throw new Error("Payment differs from its immutable signed offer");
    }
    if (payment.fulfillmentReceipt.payload.issuerAgentId !== offerPayload.providerAgentId) {
      throw new Error("Fulfillment receipt issuer differs from the signed offer providerAgentId");
    }
    assertTimestampOrder([
      ["incident", payment.incidentAt],
      ["Gemini baseline selection", evidence.selection.baseline.capturedAt],
      ["402 challenge", payment.x402.challenge.capturedAt],
    ]);
    if (Date.parse(offerPayload.expiresAt) < Date.parse(payment.confirmedAt)) {
      throw new Error("Paid offer expired before confirmation");
    }
    await verifyReceiptAndOutcome(payment, evidence.attestations, root);
    const primarySettlement = await verifyPaymentAgainstRpc(
      payment,
      x402Trace.payment,
      primary.toString(),
      fetchImpl,
    );
    if (secondary) {
      const secondarySettlement = await verifyPaymentAgainstRpc(
        payment,
        x402Trace.payment,
        secondary.toString(),
        fetchImpl,
      );
      if (
        primarySettlement.slot !== secondarySettlement.slot ||
        primarySettlement.txSignature !== secondarySettlement.txSignature ||
        canonicalize(primarySettlement.tokenAccountDeltas) !== canonicalize(secondarySettlement.tokenAccountDeltas)
      ) {
        throw new Error("Primary and secondary RPC settlement verification disagree");
      }
    }
  }

  const generatedAt = Date.parse(evidence.generatedAt);
  const latestBoundEvent = Math.max(
    ...evidence.payments.map((payment) => Date.parse(payment.outcome.payload.recoveredAt)),
    ...evidence.denials.map((denial) => Date.parse(denial.attemptedAt)),
    Date.parse(evidence.selection.baseline.capturedAt),
    Date.parse(evidence.selection.counterfactual.capturedAt),
  );
  if (generatedAt < latestBoundEvent) throw new Error("Evidence generatedAt precedes a bound runtime event");

  const report: VerificationReport = {
    schemaVersion: "1.0",
    nonce: options.nonce,
    producedAt: (options.now ?? (() => new Date()))().toISOString(),
    evidenceSha256: sha256FileBytes(evidenceBytes),
    rpcHosts: {
      primary: primary.host,
      ...(secondary ? { secondary: secondary.host } : {}),
    },
    checks: REPORT_CHECKS,
  };
  await atomicWriteReport(reportPath, report);
  return report;
}

async function readIgnoredLocalRpcEnvironment(root: string): Promise<Partial<Record<string, string>>> {
  const values: Partial<Record<string, string>> = {};
  try {
    const source = await readFile(resolve(root, ".env.local"), "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*(SOLANA_RPC_URL|SOLANA_SECONDARY_RPC_URL)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || !match[1] || !match[2]) continue;
      const raw = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
      values[match[1]] = raw;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return values;
}

async function main(): Promise<void> {
  await safelyRemove(resolve(ROOT, "artifacts/verification-report.json"));
  const local = await readIgnoredLocalRpcEnvironment(ROOT);
  const nonce = process.env.UPTIME402_VERIFICATION_NONCE;
  const primaryRpcUrl = process.env.SOLANA_RPC_URL ?? local.SOLANA_RPC_URL;
  const secondaryRpcUrl = process.env.SOLANA_SECONDARY_RPC_URL ?? local.SOLANA_SECONDARY_RPC_URL;
  if (!nonce) throw new Error("UPTIME402_VERIFICATION_NONCE is required");
  if (!primaryRpcUrl) {
    throw new Error("SOLANA_RPC_URL is required in the process environment or ignored .env.local");
  }
  const report = await verifyEvidence({
    nonce,
    primaryRpcUrl,
    ...(secondaryRpcUrl ? { secondaryRpcUrl } : {}),
  });
  console.error(`Verified evidence ${report.evidenceSha256}; report nonce ${report.nonce}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Evidence verification failed: ${message}`);
    process.exitCode = 1;
  });
}
