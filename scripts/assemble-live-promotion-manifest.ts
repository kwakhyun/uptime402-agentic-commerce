import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  RecoveryDecisionSchema,
  VendorOfferCatalogSchema,
  VendorOfferSchema,
  canonicalHash,
  canonicalize,
} from "@uptime402/domain";
import { z } from "zod";

import {
  LiveGeminiDecisionRunCaptureSchema,
  combineGeminiSelectionPair,
} from "../apps/control-plane/src/server/gemini-evidence.js";
import {
  OperatorRunIncidentRequestSchema,
  type AutomaticDenialBindingHashes,
  type AutomaticDenialBindings,
  type AutomaticDenialResults,
} from "../apps/control-plane/src/server/operator-boundary.js";
import {
  AttestationsSchema,
  ProjectSchema,
  type EvidenceAttestations,
  type EvidenceProject,
} from "./verify-evidence.js";
import {
  AutomaticDenialCapturesSchema,
  GeminiSelectionPairCaptureSchema,
  LiveEvidencePromotionInputSchema,
  VerifiedSettlementCaptureSchema,
  captureRequestBinding,
  createAutomaticDenialCaptures,
  createRecoveredPromotionManifest,
  type GeminiSelectionPairCapture,
  type LiveEvidencePromotionInput,
} from "./capture-live-evidence.js";
import { FreshRunResponseSchema } from "./mandate-run-incident.js";
import {
  readOwnerOnlyOperatorFile,
  writeNewOwnerOnlyOperatorCapture,
} from "./mandate-operator-client.js";
import { parseMandateJson } from "./mandate-json.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PRIVATE_ROOT = resolve(ROOT, "private");
const MAX_PRIVATE_JSON_BYTES = 16 * 1024 * 1024;
const MAX_REPOSITORY_ARTIFACT_BYTES = 512 * 1024 * 1024;

const SelectionPrimarySchema = z
  .object({
    outcome: z.literal("recovered"),
    transactionCreated: z.literal(true),
    txSignature: z.string().min(1),
    decision: RecoveryDecisionSchema,
    geminiBaseline: LiveGeminiDecisionRunCaptureSchema,
    offers: z.tuple([VendorOfferSchema, VendorOfferSchema]),
    selectedOffer: VendorOfferSchema,
  })
  .passthrough();

const SelectionCounterfactualSchema = z
  .object({
    outcome: z.literal("denied"),
    transactionCreated: z.literal(false),
    txSignature: z.null(),
    decision: RecoveryDecisionSchema,
    geminiBaseline: LiveGeminiDecisionRunCaptureSchema,
    selectedOffer: VendorOfferSchema,
  })
  .passthrough();

type AssemblyArguments = Readonly<{
  operatorRequestPath: string;
  operatorCapturePath: string;
  settlementPath: string;
  denialsPath: string;
  offersPath: string;
  projectPath: string;
  attestationsPath: string;
  outputPath: string;
}>;

type ArtifactReference = Readonly<{
  path: string;
  expectedSha256?: string;
}>;

function inside(candidate: string, root: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function privateAbsolutePath(value: string, option: string, privateRoot = PRIVATE_ROOT): string {
  if (!isAbsolute(value)) throw new TypeError(`${option} must be an absolute path`);
  const candidate = resolve(value);
  if (!inside(candidate, resolve(privateRoot))) {
    throw new Error(`${option} must remain under the repository private/ directory`);
  }
  return candidate;
}

export function parseAssemblyArguments(
  argv: readonly string[],
  privateRoot = PRIVATE_ROOT,
): AssemblyArguments {
  const normalized = argv.filter((value) => value !== "--");
  if (normalized.length % 2 !== 0) {
    throw new TypeError("Every live promotion assembly option requires one value");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < normalized.length; index += 2) {
    const option = normalized[index];
    const value = normalized[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      throw new TypeError("Every live promotion assembly option requires one value");
    }
    if (values.has(option)) throw new TypeError(`Duplicate live promotion option: ${option}`);
    values.set(option, value);
  }
  const names = {
    operatorRequestPath: "--operator-request",
    operatorCapturePath: "--operator-capture",
    settlementPath: "--settlement",
    denialsPath: "--denials",
    offersPath: "--offers",
    projectPath: "--project",
    attestationsPath: "--attestations",
    outputPath: "--output",
  } as const;
  const known = new Set(Object.values(names));
  for (const option of values.keys()) {
    if (!known.has(option as (typeof names)[keyof typeof names])) {
      throw new TypeError(`Unknown live promotion option: ${option}`);
    }
  }
  const read = (option: string): string => {
    const value = values.get(option)?.trim();
    if (!value) throw new Error(`Missing required option: ${option}`);
    return privateAbsolutePath(value, option, privateRoot);
  };
  const parsed = {
    operatorRequestPath: read(names.operatorRequestPath),
    operatorCapturePath: read(names.operatorCapturePath),
    settlementPath: read(names.settlementPath),
    denialsPath: read(names.denialsPath),
    offersPath: read(names.offersPath),
    projectPath: read(names.projectPath),
    attestationsPath: read(names.attestationsPath),
    outputPath: read(names.outputPath),
  };
  if (new Set(Object.values(parsed)).size !== Object.keys(parsed).length) {
    throw new Error("Live promotion input and output paths must be distinct");
  }
  return parsed;
}

function assertNoCredentialFields(value: unknown, path = "$input"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialFields(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (
      /^(?:privateKey|secretKey|mnemonic|seed|seedPhrase|authorization|cookie|apiKey|idToken|accessToken|refreshToken)$/iu.test(
        key,
      )
    ) {
      throw new Error(`Credential or signer-material field is forbidden: ${path}.${key}`);
    }
    assertNoCredentialFields(entry, `${path}.${key}`);
  }
}

async function readPrivateJson(path: string, privateRoot: string): Promise<unknown> {
  const bytes = await readOwnerOnlyOperatorFile(
    path,
    privateRoot,
    MAX_PRIVATE_JSON_BYTES,
  );
  try {
    const value = parseMandateJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    assertNoCredentialFields(value);
    return value;
  } finally {
    bytes.fill(0);
  }
}

/**
 * Uses the two Gemini calls that were already captured inside one successful
 * operator run. It never calls Gemini and preserves each rawText byte-for-byte.
 */
export function deriveSelectionFromOperatorResults(input: {
  primary: unknown;
  overTransactionLimit: unknown;
}): GeminiSelectionPairCapture {
  const primary = SelectionPrimarySchema.parse(input.primary);
  const counterfactual = SelectionCounterfactualSchema.parse(
    input.overTransactionLimit,
  );
  if (
    canonicalize(primary.geminiBaseline.decision) !== canonicalize(primary.decision) ||
    canonicalize(counterfactual.geminiBaseline.decision) !==
      canonicalize(counterfactual.decision) ||
    primary.selectedOffer.payload.offerId !== primary.decision.selectedOfferId ||
    counterfactual.selectedOffer.payload.offerId !==
      counterfactual.decision.selectedOfferId
  ) {
    throw new Error("Operator result does not bind its captured Gemini decisions");
  }
  const candidateOfferIds = primary.offers.map(
    (offer) => offer.payload.offerId,
  ) as [string, string];
  const baselineRawText = primary.geminiBaseline.generation.rawText;
  const counterfactualRawText = counterfactual.geminiBaseline.generation.rawText;
  const selection = GeminiSelectionPairCaptureSchema.parse(
    combineGeminiSelectionPair({
      candidateOfferIds,
      baseline: primary.geminiBaseline,
      counterfactual: counterfactual.geminiBaseline,
      requireLive: true,
    }),
  );
  if (
    selection.baseline.generation.rawText !== baselineRawText ||
    selection.counterfactual.generation.rawText !== counterfactualRawText
  ) {
    throw new Error("Gemini raw output changed during promotion assembly");
  }
  return selection;
}

function assertDescriptorBindings(input: {
  manifest: LiveEvidencePromotionInput;
  operatorRequest: z.infer<typeof OperatorRunIncidentRequestSchema>;
}): void {
  const { manifest, operatorRequest } = input;
  const recovered = manifest.recovered!;
  const settlement = manifest.settlement!;
  const offers = manifest.offers!;
  const selection = manifest.selection!;
  const project = manifest.project!;
  const attestations = manifest.attestations!;
  const result = recovered.result;
  const selected = result.selectedOffer;
  if (
    result.txSignature !== settlement.txSignature ||
    selected.payload.amountBaseUnits !== settlement.amountBaseUnits ||
    selected.payload.payee !== settlement.payeeOwner ||
    selected.payload.assetMint !== settlement.assetMint ||
    selected.payload.network !== settlement.network ||
    operatorRequest.request.executionPolicy.executorPublicKey !== settlement.payerOwner
  ) {
    throw new Error("Recovered payment, signed offer, execution policy, and settlement differ");
  }
  if (
    canonicalize(result.offers) !== canonicalize(offers) ||
    canonicalize(selection.baseline) !== canonicalize(result.geminiBaseline)
  ) {
    throw new Error("Promotion changed the live signed offers or Gemini baseline");
  }
  if (
    operatorRequest.request.executionPolicy.policyHash !==
      attestations.policy.executionPolicyHash ||
    selection.baseline.generation.requestedModel !== attestations.gemini.model ||
    selection.counterfactual.generation.requestedModel !== attestations.gemini.model
  ) {
    throw new Error("Runtime attestations differ from the live policy or Gemini calls");
  }
  for (const offer of offers) {
    if (
      offer.signer !== attestations.a2a.verificationPublicKey ||
      offer.keyId !== attestations.a2a.verificationKeyId ||
      offer.payload.providerAgentCardUrl !== attestations.a2a.agentCardUrl ||
      offer.payload.providerAgentCardHash !== attestations.a2a.agentCardHash
    ) {
      throw new Error("A2A attestation differs from a promoted signed offer");
    }
  }
  if (
    result.recoveryOutcome.signer !== attestations.autonomy.verificationPublicKey ||
    result.recoveryOutcome.keyId !== attestations.autonomy.verificationKeyId
  ) {
    throw new Error("Autonomy attestation differs from the signed recovery outcome");
  }
  const services = new Map(project.services.map((service) => [service.role, service]));
  if (
    new URL(project.liveUrl).origin !==
      new URL(services.get("control-plane")!.url).origin ||
    new URL(attestations.a2a.agentCardUrl).origin !==
      new URL(services.get("vendor-agent")!.url).origin
  ) {
    throw new Error("Project service origins differ from the live UI or A2A attestation");
  }
}

export function buildLivePromotionManifest(input: {
  operatorRequest: unknown;
  operatorCapture: unknown;
  settlement: unknown;
  denials: unknown;
  offerCatalog: unknown;
  project: unknown;
  attestations: unknown;
}): LiveEvidencePromotionInput {
  const operatorRequest = OperatorRunIncidentRequestSchema.parse(input.operatorRequest);
  const fresh = FreshRunResponseSchema.parse(input.operatorCapture);
  const settlement = VerifiedSettlementCaptureSchema.parse(input.settlement);
  const denials = AutomaticDenialCapturesSchema.parse(input.denials);
  const offerCatalog = VendorOfferCatalogSchema.parse(input.offerCatalog);
  const project = ProjectSchema.parse(input.project);
  const attestations = AttestationsSchema.parse(input.attestations);
  if (
    fresh.idempotentReplay ||
    fresh.result.primary.outcome !== "recovered" ||
    fresh.result.primary.transactionCreated !== true ||
    fresh.result.primary.txSignature === null ||
    !fresh.result.denials ||
    !fresh.result.denialBindings ||
    !fresh.result.denialBindingHashes
  ) {
    throw new Error("One fresh recovered operator run with both live denials is required");
  }
  const selection = deriveSelectionFromOperatorResults({
    primary: fresh.result.primary,
    overTransactionLimit: fresh.result.denials.overTransactionLimit,
  });
  const recovered = createRecoveredPromotionManifest({
    request: captureRequestBinding(operatorRequest.request),
    result: fresh.result.primary as Parameters<
      typeof createRecoveredPromotionManifest
    >[0]["result"],
    selection,
  });
  if (canonicalize(recovered.offers) !== canonicalize(offerCatalog.offers)) {
    throw new Error("Signed offer catalog differs from the successful operator capture");
  }
  const derivedDenials = createAutomaticDenialCaptures({
    operatorRequest,
    results: fresh.result.denials as unknown as AutomaticDenialResults,
    bindings: fresh.result.denialBindings as AutomaticDenialBindings,
    bindingHashes:
      fresh.result.denialBindingHashes as AutomaticDenialBindingHashes,
    originalTxSignature: settlement.txSignature,
    originalExplorerUrl: settlement.explorerUrl,
  });
  if (canonicalize(denials) !== canonicalize(derivedDenials)) {
    throw new Error("Denial fragment differs from the bound operator run");
  }
  const manifest = LiveEvidencePromotionInputSchema.parse({
    schemaVersion: "1.0",
    recovered: recovered.recovered,
    settlement,
    offers: offerCatalog.offers,
    selection,
    denials,
    project,
    attestations,
  });
  assertDescriptorBindings({ manifest, operatorRequest });
  assertNoCredentialFields(manifest, "$manifest");
  return manifest;
}

function descriptorArtifactReferences(
  project: EvidenceProject,
  attestations: EvidenceAttestations,
): ArtifactReference[] {
  const references: ArtifactReference[] = [
    { path: project.deploymentArtifact },
    {
      path: project.projectIamPolicyArtifact,
      expectedSha256: project.projectIamPolicyArtifactSha256,
    },
    { path: project.deckPdf },
    ...(project.demoVideo ? [{ path: project.demoVideo }] : []),
  ];
  for (const service of project.services) {
    references.push(
      { path: service.deploymentArtifact },
      {
        path: service.serviceDescribeArtifact,
        expectedSha256: service.serviceDescribeArtifactSha256,
      },
      {
        path: service.iamPolicyArtifact,
        expectedSha256: service.iamPolicyArtifactSha256,
      },
    );
    if (service.secretIamPolicyArtifact && service.secretIamPolicyArtifactSha256) {
      references.push({
        path: service.secretIamPolicyArtifact,
        expectedSha256: service.secretIamPolicyArtifactSha256,
      });
    }
  }
  for (const attestation of Object.values(attestations)) {
    references.push(
      ...attestation.sourcePaths.map((path) => ({ path })),
      {
        path: attestation.runtimeArtifact,
        expectedSha256: attestation.runtimeArtifactSha256,
      },
    );
  }
  return references;
}

async function validateRepositoryArtifact(
  repositoryRoot: string,
  reference: ArtifactReference,
): Promise<void> {
  if (isAbsolute(reference.path)) {
    throw new Error(`Promotion artifact path must be repository-relative: ${reference.path}`);
  }
  const rootReal = await realpath(repositoryRoot);
  const artifactReal = await realpath(resolve(repositoryRoot, reference.path));
  if (artifactReal !== rootReal && !artifactReal.startsWith(`${rootReal}${sep}`)) {
    throw new Error(`Promotion artifact escapes the repository: ${reference.path}`);
  }
  const metadata = await stat(artifactReal);
  if (
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > MAX_REPOSITORY_ARTIFACT_BYTES
  ) {
    throw new Error(`Promotion artifact is missing, empty, or too large: ${reference.path}`);
  }
  if (reference.expectedSha256) {
    const actual = `sha256:${createHash("sha256")
      .update(await readFile(artifactReal))
      .digest("hex")}`;
    if (actual !== reference.expectedSha256) {
      throw new Error(`Promotion artifact hash mismatch: ${reference.path}`);
    }
  }
}

export async function assembleLivePromotionManifest(options: {
  paths: AssemblyArguments;
  repositoryRoot?: string;
  privateRoot?: string;
}): Promise<{ outputPath: string; manifestHash: `sha256:${string}` }> {
  const repositoryRoot = resolve(options.repositoryRoot ?? ROOT);
  const privateRoot = resolve(options.privateRoot ?? PRIVATE_ROOT);
  if (privateRoot !== resolve(repositoryRoot, "private")) {
    throw new Error("Live promotion input and output root must be repository private/");
  }
  const [
    operatorRequest,
    operatorCapture,
    settlement,
    denials,
    offerCatalog,
    projectInput,
    attestationInput,
  ] = await Promise.all([
    readPrivateJson(options.paths.operatorRequestPath, privateRoot),
    readPrivateJson(options.paths.operatorCapturePath, privateRoot),
    readPrivateJson(options.paths.settlementPath, privateRoot),
    readPrivateJson(options.paths.denialsPath, privateRoot),
    readPrivateJson(options.paths.offersPath, privateRoot),
    readPrivateJson(options.paths.projectPath, privateRoot),
    readPrivateJson(options.paths.attestationsPath, privateRoot),
  ]);
  const manifest = buildLivePromotionManifest({
    operatorRequest,
    operatorCapture,
    settlement,
    denials,
    offerCatalog,
    project: projectInput,
    attestations: attestationInput,
  });
  await Promise.all(
    descriptorArtifactReferences(manifest.project!, manifest.attestations!).map(
      (reference) => validateRepositoryArtifact(repositoryRoot, reference),
    ),
  );
  await writeNewOwnerOnlyOperatorCapture(
    options.paths.outputPath,
    privateRoot,
    manifest,
  );
  return {
    outputPath: options.paths.outputPath,
    manifestHash: canonicalHash(manifest),
  };
}

async function main(): Promise<void> {
  const paths = parseAssemblyArguments(process.argv.slice(2));
  const result = await assembleLivePromotionManifest({ paths });
  process.stdout.write(`${canonicalize(result)}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Live promotion assembly failed"}\n`,
    );
    process.exitCode = 1;
  });
}
