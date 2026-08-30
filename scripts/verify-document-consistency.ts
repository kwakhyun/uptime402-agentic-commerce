import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

async function bytes(path: string): Promise<Uint8Array> {
  return readFile(resolve(root, path));
}

async function text(path: string): Promise<string> {
  return Buffer.from(await bytes(path)).toString("utf8");
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

const evidenceBytes = await bytes("artifacts/payment-evidence.json");
const reportBytes = await bytes("artifacts/verification-report.json");
const evidenceHash = hash(evidenceBytes);
const reportHash = hash(reportBytes);
const evidence = exactRecord(JSON.parse(Buffer.from(evidenceBytes).toString("utf8")), "payment evidence");
const report = exactRecord(JSON.parse(Buffer.from(reportBytes).toString("utf8")), "verification report");
if (report.evidenceSha256 !== `sha256:${evidenceHash}`) {
  throw new Error("verification-report.json does not bind payment-evidence.json");
}

const deployment = exactRecord(
  JSON.parse(await text("artifacts/portfolio-deployment/manifest.json")),
  "portfolio deployment manifest",
);
const deploymentPins = exactRecord(deployment.evidencePins, "portfolio deployment evidence pins");
if (deployment.notPaymentEvidence !== true) {
  throw new Error("portfolio deployment manifest must be marked notPaymentEvidence");
}
if (
  deploymentPins.paymentEvidenceSha256 !== `sha256:${evidenceHash}` ||
  deploymentPins.verificationReportSha256 !== `sha256:${reportHash}`
) {
  throw new Error("portfolio deployment manifest does not pin the promoted evidence bytes");
}
const deploymentServices = deployment.services;
if (!Array.isArray(deploymentServices)) throw new Error("portfolio deployment services must be an array");
const controlService = deploymentServices
  .map((value, index) => exactRecord(value, `portfolio deployment service ${index}`))
  .find((value) => value.role === "control-plane");
if (!controlService) throw new Error("portfolio deployment manifest is missing control-plane");

const payments = evidence.payments;
if (!Array.isArray(payments) || payments.length !== 1) {
  throw new Error("Preserved portfolio evidence must contain exactly one payment");
}
const payment = exactRecord(payments[0], "payment evidence record");
const txSignature = String(payment.txSignature);
const amount = String(payment.amount);
const amountBaseUnits = String(payment.amountBaseUnits);
const attestations = exactRecord(evidence.attestations, "attestations");
const gemini = exactRecord(attestations.gemini, "Gemini attestation");
const model = String(gemini.model);

const claimDocuments = [
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/BUILD_STATUS.md",
  "docs/SUBMISSION_DECK.md",
] as const;
for (const path of claimDocuments) {
  const source = await text(path);
  for (const required of [evidenceHash, reportHash, txSignature]) {
    if (!source.includes(required)) {
      throw new Error(`${path} is missing evidence-bound claim ${required}`);
    }
  }
  if (!source.includes(amount) || !source.includes(amountBaseUnits)) {
    throw new Error(`${path} is missing the evidence-bound payment amount`);
  }
}

for (const path of ["README.md", "docs/ARCHITECTURE.md", "docs/BUILD_STATUS.md", "docs/DEMO_SCRIPT.md", "docs/SUBMISSION_DECK.md"] as const) {
  const source = await text(path);
  if (!source.includes(model)) {
    throw new Error(`${path} must name the preserved evidence model ${model}`);
  }
}

const index = await text("artifacts/INDEX.md");
for (const required of [
  "artifacts/payment-evidence.json",
  "artifacts/verification-report.json",
  "artifacts/final-deployment/",
  "artifacts/portfolio-deployment/",
  "artifacts/local/",
]) {
  if (!index.includes(required)) throw new Error(`artifacts/INDEX.md is missing ${required}`);
}

const architecture = await text("docs/ARCHITECTURE.md");
if (architecture.includes("GIS popup")) {
  throw new Error("ARCHITECTURE.md must expand Google Identity Services instead of GIS popup");
}

for (const path of ["README.md", "docs/BUILD_STATUS.md", "deploy/README.md"] as const) {
  const source = await text(path);
  for (const required of [
    String(deployment.sourceCommit),
    String(deployment.buildId),
    String(deployment.controlImageDigest),
    String(controlService.revision),
  ]) {
    if (!source.includes(required)) {
      throw new Error(`${path} is missing current deployment claim ${required}`);
    }
  }
  if (source.includes("artifacts/local/portfolio-release-verification.json")) {
    throw new Error(`${path} references the superseded portfolio release summary`);
  }
}
if (architecture.includes("react-62f9767") || architecture.includes("57a697fc-c9d3-4375-85b1-24fe52cefa1e")) {
  throw new Error("ARCHITECTURE.md contains a stale current portfolio deployment identifier");
}

process.stdout.write(
  `document consistency: verified evidence=${evidenceHash} report=${reportHash} model=${model}\n`,
);
