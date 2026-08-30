import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const outputRoot = resolve(root, "artifacts/portfolio-deployment");
const privateOutputRoot = resolve(root, "private/portfolio-deployment-raw");
const HASH = /^sha256:[0-9a-f]{64}$/u;

type JsonRecord = Record<string, unknown>;

type ServiceRole = "control-plane" | "payment-executor" | "vendor-agent";

type ServiceEvidence = Readonly<{
  role: ServiceRole;
  serviceName: string;
  revision: string;
  serviceAccount: string;
  stableUrl: string;
  image: string;
  descriptionSha256: string;
  iamPolicySha256: string;
}>;

type PortfolioDeploymentManifest = Readonly<{
  schemaVersion: "1.0";
  artifactKind: "portfolio-replay-deployment-evidence";
  notPaymentEvidence: true;
  capturedAt: string;
  projectId: string;
  region: string;
  sourceCommit: string;
  buildId: string;
  buildExportSha256: string;
  controlImageDigest: string;
  projectIamExportSha256: string;
  retiredControlPolicyExportSha256s: readonly string[];
  replayBoundaryAssertions: Readonly<{
    controlNoMutationDependencies: true;
    controlNoForbiddenProjectRoles: true;
    controlNoRetiredConfigAccess: true;
    executorHasNoInvoker: true;
    controlAndVendorPublic: true;
  }>;
  services: readonly ServiceEvidence[];
  liveChecks: Readonly<{
    controlRootStatus: number;
    controlHealthStatus: number;
    controlMutationStatus: number;
    vendorHealthStatus: number;
    vendorAgentCardStatus: number;
    executorUnauthenticatedStatus: number;
  }>;
  evidencePins: Readonly<{
    paymentEvidenceSha256: string;
    verificationReportSha256: string;
  }>;
}>;

const serviceNames: Readonly<Record<ServiceRole, string>> = Object.freeze({
  "control-plane": "uptime402-control-plane",
  "payment-executor": "uptime402-payment-executor",
  "vendor-agent": "uptime402-vendor-agent",
});
const projectNumber = "1065649463621";
const deploymentRegion = "asia-northeast3";
const retiredControlSecretNames = Object.freeze([
  "uptime402-control-outcome",
  "uptime402-demo-request",
  "uptime402-demo-mandate",
]);
const retiredControlPolicyFiles = Object.freeze<Record<string, string>>({
  "uptime402-control-outcome": "retired-control-outcome.iam.json",
  "uptime402-demo-request": "retired-demo-request.iam.json",
  "uptime402-demo-mandate": "retired-demo-mandate.iam.json",
});

function exactRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writePrivateRawArtifact(filename: string, value: unknown): Promise<string> {
  const bytes = jsonBytes(value);
  await writeFile(resolve(privateOutputRoot, filename), bytes, { mode: 0o600 });
  return sha256(bytes);
}

async function gcloudJson(args: readonly string[]): Promise<JsonRecord> {
  const { stdout } = await execFileAsync("gcloud", [...args, "--format=json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return exactRecord(JSON.parse(stdout), `gcloud ${args.join(" ")}`);
}

function nestedRecord(value: JsonRecord, key: string, label: string): JsonRecord {
  return exactRecord(value[key], `${label}.${key}`);
}

function roleMembers(policy: JsonRecord, role: string): Set<string> {
  const bindings = Array.isArray(policy.bindings) ? policy.bindings : [];
  const members = new Set<string>();
  for (const rawBinding of bindings) {
    const binding = exactRecord(rawBinding, "IAM binding");
    if (binding.role !== role || !Array.isArray(binding.members)) continue;
    for (const member of binding.members) {
      members.add(exactString(member, "IAM member"));
    }
  }
  return members;
}

function principalRoles(policy: JsonRecord, principal: string): Set<string> {
  const bindings = Array.isArray(policy.bindings) ? policy.bindings : [];
  const roles = new Set<string>();
  for (const rawBinding of bindings) {
    const binding = exactRecord(rawBinding, "IAM binding");
    if (
      typeof binding.role === "string" &&
      Array.isArray(binding.members) &&
      binding.members.includes(principal)
    ) {
      roles.add(binding.role);
    }
  }
  return roles;
}

function validateRetiredControlAccess(
  controlServiceAccount: string,
  projectIam: JsonRecord,
  secretPolicies: readonly Readonly<{ secretName: string; policy: JsonRecord }>[],
): void {
  const principal = `serviceAccount:${controlServiceAccount}`;
  const forbiddenProjectRoles = new Set([
    "roles/aiplatform.user",
    "roles/datastore.user",
    "roles/run.invoker",
    "roles/secretmanager.secretAccessor",
    "roles/owner",
    "roles/editor",
  ]);
  const unexpected = [...principalRoles(projectIam, principal)].filter((role) =>
    forbiddenProjectRoles.has(role)
  );
  if (unexpected.length > 0) {
    throw new Error(`Replay control identity retains project roles: ${unexpected.join(", ")}`);
  }
  for (const { secretName, policy } of secretPolicies) {
    if (roleMembers(policy, "roles/secretmanager.secretAccessor").has(principal)) {
      throw new Error(`Replay control identity still accesses retired secret ${secretName}`);
    }
  }
}

function serviceEnv(description: JsonRecord): Map<string, string> {
  const spec = nestedRecord(description, "spec", "service");
  const template = nestedRecord(spec, "template", "service.spec");
  const templateSpec = nestedRecord(template, "spec", "service.spec.template");
  const containers = templateSpec.containers;
  if (!Array.isArray(containers) || containers.length !== 1) {
    throw new TypeError("Cloud Run service must have exactly one container");
  }
  const container = exactRecord(containers[0], "service container");
  const values = new Map<string, string>();
  const env = Array.isArray(container.env) ? container.env : [];
  for (const raw of env) {
    const entry = exactRecord(raw, "service env");
    values.set(exactString(entry.name, "service env name"), exactString(entry.value, "service env value"));
  }
  return values;
}

function validateReadyService(
  role: ServiceRole,
  expectedName: string,
  description: JsonRecord,
): Omit<ServiceEvidence, "descriptionSha256" | "iamPolicySha256"> {
  const metadata = nestedRecord(description, "metadata", "service");
  const spec = nestedRecord(description, "spec", "service");
  const template = nestedRecord(spec, "template", "service.spec");
  const templateMetadata = nestedRecord(template, "metadata", "service.spec.template");
  const templateSpec = nestedRecord(template, "spec", "service.spec.template");
  const status = nestedRecord(description, "status", "service");
  if (metadata.name !== expectedName || metadata.generation !== status.observedGeneration) {
    throw new Error(`${role} description is not the expected observed generation`);
  }
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  const ready = conditions.some((raw) => {
    const condition = exactRecord(raw, `${role} condition`);
    return condition.type === "Ready" && condition.status === "True";
  });
  if (!ready) throw new Error(`${role} is not Ready`);
  const traffic = Array.isArray(status.traffic) ? status.traffic : [];
  if (!traffic.some((raw) => exactRecord(raw, `${role} traffic`).percent === 100)) {
    throw new Error(`${role} does not send 100% traffic to a ready revision`);
  }
  const containers = templateSpec.containers;
  if (!Array.isArray(containers) || containers.length !== 1) {
    throw new Error(`${role} must use one container`);
  }
  const container = exactRecord(containers[0], `${role} container`);
  const annotations = exactRecord(metadata.annotations ?? {}, `${role} metadata annotations`);
  const rawUrls = exactString(annotations["run.googleapis.com/urls"], `${role} official URLs`);
  const urls = JSON.parse(rawUrls);
  if (!Array.isArray(urls) || !urls.every((url) => typeof url === "string")) {
    throw new Error(`${role} official URL annotation is invalid`);
  }
  const stableUrl = `https://${expectedName}-${projectNumber}.${deploymentRegion}.run.app`;
  const statusUrl = exactString(status.url, `${role} URL`);
  if (!urls.includes(stableUrl) || !urls.includes(statusUrl)) {
    throw new Error(`${role} raw description does not bind its stable and generated URLs`);
  }

  if (role === "control-plane") {
    const env = serviceEnv(description);
    const expectedEvidence = sha256(awaitedPaymentEvidenceBytes);
    const expectedReport = sha256(awaitedVerificationReportBytes);
    const expected = new Map([
      ["CONTROL_PLANE_UI_LIVE_TRIGGER_ENABLED", "false"],
      ["CONTROL_PLANE_MUTATIONS_ENABLED", "false"],
      ["UPTIME402_UI_EVIDENCE_STAGE", "final"],
      ["UPTIME402_UI_EVIDENCE_SHA256", expectedEvidence],
      ["UPTIME402_UI_VERIFICATION_REPORT_SHA256", expectedReport],
    ]);
    for (const [name, value] of expected) {
      if (env.get(name) !== value) throw new Error(`Replay control env mismatch: ${name}`);
    }
    const forbiddenEnv = [
      "FIRESTORE_PROJECT_ID",
      "PAYMENT_EXECUTOR_ORIGIN",
      "CONTROL_PLANE_OPERATOR_AUDIENCE",
      "CONTROL_PLANE_UI_GOOGLE_CLIENT_ID",
      "CONTROL_PLANE_OUTCOME_KEY_PATH",
      "CONTROL_PLANE_UI_LIVE_REQUEST_PATH",
      "CONTROL_PLANE_DEMO_RUN_SLOT",
      "GOOGLE_CLOUD_PROJECT",
    ];
    if (forbiddenEnv.some((name) => env.has(name))) {
      throw new Error("Replay control service retains a mutation dependency");
    }
    const annotations = exactRecord(templateMetadata.annotations ?? {}, "control annotations");
    if ("run.googleapis.com/secrets" in annotations) {
      throw new Error("Replay control service must not declare Secret Manager mounts");
    }
    if (Array.isArray(templateSpec.volumes) && templateSpec.volumes.length > 0) {
      throw new Error("Replay control service must not declare volumes");
    }
    if (Array.isArray(container.volumeMounts) && container.volumeMounts.length > 0) {
      throw new Error("Replay control service must not declare volume mounts");
    }
  }

  return Object.freeze({
    role,
    serviceName: expectedName,
    revision: exactString(status.latestReadyRevisionName, `${role} revision`),
    serviceAccount: exactString(templateSpec.serviceAccountName, `${role} service account`),
    stableUrl,
    image: exactString(container.image, `${role} image`),
  });
}

let awaitedPaymentEvidenceBytes: Uint8Array;
let awaitedVerificationReportBytes: Uint8Array;

function validateIam(role: ServiceRole, policy: JsonRecord): void {
  const invokers = roleMembers(policy, "roles/run.invoker");
  if (role === "control-plane" || role === "vendor-agent") {
    if (!invokers.has("allUsers")) throw new Error(`${role} must remain publicly readable`);
    return;
  }
  if (invokers.size !== 0) {
    throw new Error("Portfolio replay executor must have no active run.invoker binding");
  }
}

function controlImageDigest(build: JsonRecord, sourceCommit: string): string {
  const results = exactRecord(build.results, "Cloud Build results");
  const images = Array.isArray(results.images) ? results.images : [];
  const matched = images.find((raw) => {
    const image = exactRecord(raw, "Cloud Build image");
    return typeof image.name === "string" && image.name.endsWith(`/control-plane:${sourceCommit}`);
  });
  if (!matched) throw new Error("Cloud Build did not publish the source-commit control image");
  const digest = exactString(exactRecord(matched, "Cloud Build control image").digest, "control image digest");
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error("Cloud Build control image digest is invalid");
  }
  return digest;
}

async function boundedStatus(url: string, init?: RequestInit): Promise<number> {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  return response.status;
}

async function capture(buildId: string, sourceCommit: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new TypeError("source commit must be a full Git SHA");
  if (!/^[0-9a-f-]{20,64}$/u.test(buildId)) throw new TypeError("Cloud Build ID is invalid");
  const projectId = "uptime402-hack-260803";
  const region = deploymentRegion;
  awaitedPaymentEvidenceBytes = await readFile(resolve(root, "artifacts/payment-evidence.json"));
  awaitedVerificationReportBytes = await readFile(resolve(root, "artifacts/verification-report.json"));
  await mkdir(outputRoot, { recursive: true });
  await mkdir(privateOutputRoot, { recursive: true, mode: 0o700 });

  const services: ServiceEvidence[] = [];
  for (const role of Object.keys(serviceNames) as ServiceRole[]) {
    const serviceName = serviceNames[role];
    const description = await gcloudJson([
      "run", "services", "describe", serviceName,
      `--project=${projectId}`,
      `--region=${region}`,
    ]);
    const iamPolicy = await gcloudJson([
      "run", "services", "get-iam-policy", serviceName,
      `--project=${projectId}`,
      `--region=${region}`,
    ]);
    const summary = validateReadyService(role, serviceName, description);
    validateIam(role, iamPolicy);
    services.push(Object.freeze({
      ...summary,
      descriptionSha256: await writePrivateRawArtifact(`${role}.service.json`, description),
      iamPolicySha256: await writePrivateRawArtifact(`${role}.iam.json`, iamPolicy),
    }));
  }

  const build = await gcloudJson([
    "builds", "describe", buildId,
    `--project=${projectId}`,
    `--region=${region}`,
  ]);
  if (build.status !== "SUCCESS") throw new Error("Portfolio Cloud Build is not successful");
  const imageDigest = controlImageDigest(build, sourceCommit);
  const control = services.find((service) => service.role === "control-plane")!;
  const executor = services.find((service) => service.role === "payment-executor")!;
  const vendor = services.find((service) => service.role === "vendor-agent")!;
  const mutationUrl = `${control.stableUrl}/api/operator/incidents/demo-run`;
  const projectIam = await gcloudJson([
    "projects", "get-iam-policy", projectId,
  ]);
  const secretPolicies: Array<Readonly<{ secretName: string; policy: JsonRecord }>> = [];
  for (const secretName of retiredControlSecretNames) {
    secretPolicies.push(Object.freeze({
      secretName,
      policy: await gcloudJson([
        "secrets", "get-iam-policy", secretName,
        `--project=${projectId}`,
      ]),
    }));
  }
  validateRetiredControlAccess(control.serviceAccount, projectIam, secretPolicies);
  const liveChecks = Object.freeze({
    controlRootStatus: await boundedStatus(control.stableUrl),
    controlHealthStatus: await boundedStatus(`${control.stableUrl}/api/health`),
    controlMutationStatus: await boundedStatus(mutationUrl, { method: "POST" }),
    vendorHealthStatus: await boundedStatus(`${vendor.stableUrl}/health`),
    vendorAgentCardStatus: await boundedStatus(`${vendor.stableUrl}/.well-known/agent-card.json`),
    executorUnauthenticatedStatus: await boundedStatus(executor.stableUrl),
  });
  if (
    liveChecks.controlRootStatus !== 200 ||
    liveChecks.controlHealthStatus !== 200 ||
    liveChecks.controlMutationStatus !== 404 ||
    liveChecks.vendorHealthStatus !== 200 ||
    liveChecks.vendorAgentCardStatus !== 200 ||
    ![401, 403].includes(liveChecks.executorUnauthenticatedStatus)
  ) {
    throw new Error(`Portfolio live checks failed: ${JSON.stringify(liveChecks)}`);
  }

  const manifest: PortfolioDeploymentManifest = Object.freeze({
    schemaVersion: "1.0",
    artifactKind: "portfolio-replay-deployment-evidence",
    notPaymentEvidence: true,
    capturedAt: new Date().toISOString(),
    projectId,
    region,
    sourceCommit,
    buildId,
    buildExportSha256: await writePrivateRawArtifact("cloud-build.json", build),
    controlImageDigest: imageDigest,
    projectIamExportSha256: await writePrivateRawArtifact("project.iam.json", projectIam),
    retiredControlPolicyExportSha256s: await Promise.all(secretPolicies.map(
      async ({ secretName, policy }) => writePrivateRawArtifact(retiredControlPolicyFiles[secretName]!, policy),
    )),
    replayBoundaryAssertions: Object.freeze({
      controlNoMutationDependencies: true,
      controlNoForbiddenProjectRoles: true,
      controlNoRetiredConfigAccess: true,
      executorHasNoInvoker: true,
      controlAndVendorPublic: true,
    }),
    services,
    liveChecks,
    evidencePins: Object.freeze({
      paymentEvidenceSha256: sha256(awaitedPaymentEvidenceBytes),
      verificationReportSha256: sha256(awaitedVerificationReportBytes),
    }),
  });
  await writeFile(resolve(outputRoot, "manifest.json"), jsonBytes(manifest), { mode: 0o644 });
  await verify();
  process.stdout.write("portfolio deployment evidence captured: artifacts/portfolio-deployment/manifest.json\n");
}

async function verify(): Promise<void> {
  awaitedPaymentEvidenceBytes = await readFile(resolve(root, "artifacts/payment-evidence.json"));
  awaitedVerificationReportBytes = await readFile(resolve(root, "artifacts/verification-report.json"));
  const manifestBytes = await readFile(resolve(outputRoot, "manifest.json"));
  const manifest = exactRecord(JSON.parse(manifestBytes.toString("utf8")), "portfolio manifest") as PortfolioDeploymentManifest;
  if (
    manifest.schemaVersion !== "1.0" ||
    manifest.artifactKind !== "portfolio-replay-deployment-evidence" ||
    manifest.notPaymentEvidence !== true ||
    !Array.isArray(manifest.services) ||
    manifest.services.length !== 3
  ) {
    throw new Error("Portfolio deployment manifest shape is invalid");
  }
  if (
    manifest.evidencePins.paymentEvidenceSha256 !== sha256(awaitedPaymentEvidenceBytes) ||
    manifest.evidencePins.verificationReportSha256 !== sha256(awaitedVerificationReportBytes)
  ) {
    throw new Error("Portfolio replay evidence pins do not match tracked bytes");
  }
  if (
    !/^[0-9a-f]{40}$/u.test(manifest.sourceCommit) ||
    !HASH.test(manifest.buildExportSha256) ||
    !HASH.test(manifest.projectIamExportSha256) ||
    !HASH.test(manifest.controlImageDigest) ||
    !Array.isArray(manifest.retiredControlPolicyExportSha256s) ||
    manifest.retiredControlPolicyExportSha256s.length !== retiredControlSecretNames.length ||
    !manifest.retiredControlPolicyExportSha256s.every((value) => HASH.test(value))
  ) {
    throw new Error("Portfolio deployment digest attestation is invalid");
  }
  const assertions = manifest.replayBoundaryAssertions;
  if (!assertions || Object.values(assertions).some((value) => value !== true)) {
    throw new Error("Portfolio replay boundary assertions are incomplete");
  }
  const identities = new Set<string>();
  const roles = new Set<ServiceRole>();
  for (const service of manifest.services) {
    if (!Object.hasOwn(serviceNames, service.role)) {
      throw new Error("Portfolio deployment attestation contains an unknown service role");
    }
    const role = service.role as ServiceRole;
    if (
      serviceNames[role] !== service.serviceName ||
      service.stableUrl !== `https://${service.serviceName}-${projectNumber}.${deploymentRegion}.run.app` ||
      !HASH.test(service.descriptionSha256) ||
      !HASH.test(service.iamPolicySha256)
    ) throw new Error(`${service.role} public deployment attestation is invalid`);
    identities.add(service.serviceAccount);
    roles.add(role);
  }
  if (identities.size !== 3 || roles.size !== 3) {
    throw new Error("Portfolio services must retain three distinct roles and identities");
  }
  const control = manifest.services.find((service) => service.role === "control-plane");
  if (
    !control ||
    !control.image.endsWith(`/control-plane:${manifest.sourceCommit}`) ||
    manifest.liveChecks.controlRootStatus !== 200 ||
    manifest.liveChecks.controlHealthStatus !== 200 ||
    manifest.liveChecks.controlMutationStatus !== 404 ||
    manifest.liveChecks.vendorHealthStatus !== 200 ||
    manifest.liveChecks.vendorAgentCardStatus !== 200 ||
    ![401, 403].includes(manifest.liveChecks.executorUnauthenticatedStatus)
  ) {
    throw new Error("Portfolio replay live attestation is invalid");
  }
  process.stdout.write("portfolio deployment evidence: verified\n");
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "capture") {
  const buildId = args.find((arg) => arg.startsWith("--build-id="))?.slice("--build-id=".length);
  const sourceCommit = args.find((arg) => arg.startsWith("--source-commit="))?.slice("--source-commit=".length);
  if (!buildId || !sourceCommit) {
    throw new TypeError("capture requires --build-id=<id> and --source-commit=<full-sha>");
  }
  await capture(buildId, sourceCommit);
} else if (mode === "verify") {
  await verify();
} else {
  throw new TypeError("use capture or verify");
}
