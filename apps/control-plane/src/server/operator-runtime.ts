import "server-only";

import { Firestore } from "@google-cloud/firestore";
import { normalizePinnedOrigin } from "@uptime402/domain";

import { buildProductionControlPlaneLiveFlow } from "./runtime.js";
import {
  GoogleOperatorOidcTokenVerifier,
  OperatorAuthenticationError,
  parseOperatorOidcAuthConfig,
} from "./operator-auth.js";
import {
  OperatorBoundaryError,
  OperatorControlPlaneBoundary,
} from "./operator-boundary.js";
import {
  ExecutorAdministrationProxyError,
  GoogleControlPlaneServiceIdentityTokenProvider,
  PrivateExecutorAdministrationProxy,
} from "./operator-executor-proxy.js";
import { FirestoreOperatorIncidentCaptureStore } from "./operator-capture.js";
import { FirestoreOperatorActionGuard } from "./operator-guard.js";
import { createProductionOriginBoundFetchFactory } from "./pinned-fetch.js";
import { parseStrictJson } from "./strict-json.js";

const MAX_OPERATOR_REQUEST_BYTES = 512 * 1024;

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

export type ProductionOperatorBoundaryRuntimeConfig = Readonly<{
  firestoreProjectId: string;
  firestoreDatabaseId: string;
  firestoreCollectionPrefix: string;
  executorOrigin: string;
  demoRunSlot: string;
  demoMandateId: string;
  httpTimeoutMs: number;
  httpMaxResponseBytes: number;
}>;

export function parseProductionOperatorBoundaryRuntimeConfig(
  environment: Readonly<NodeJS.ProcessEnv>,
): ProductionOperatorBoundaryRuntimeConfig {
  if (environment.FIRESTORE_EMULATOR_HOST?.trim()) {
    throw new Error("Production operator boundary refuses FIRESTORE_EMULATOR_HOST");
  }
  const firestoreCollectionPrefix = required(
    environment,
    "FIRESTORE_COLLECTION_PREFIX",
  );
  if (!/^[a-z][a-z0-9_-]{0,47}$/u.test(firestoreCollectionPrefix)) {
    throw new TypeError("FIRESTORE_COLLECTION_PREFIX is invalid");
  }
  return Object.freeze({
    firestoreProjectId: required(environment, "FIRESTORE_PROJECT_ID"),
    firestoreDatabaseId: environment.FIRESTORE_DATABASE_ID?.trim() || "(default)",
    firestoreCollectionPrefix,
    executorOrigin: normalizePinnedOrigin(
      required(environment, "PAYMENT_EXECUTOR_ORIGIN"),
    ),
    demoRunSlot: required(environment, "CONTROL_PLANE_DEMO_RUN_SLOT"),
    demoMandateId: required(environment, "CONTROL_PLANE_DEMO_MANDATE_ID"),
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

export function buildProductionOperatorBoundary(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): OperatorControlPlaneBoundary {
  const config = parseProductionOperatorBoundaryRuntimeConfig(environment);
  const auth = parseOperatorOidcAuthConfig(environment);
  const firestore = new Firestore({
    projectId: config.firestoreProjectId,
    databaseId: config.firestoreDatabaseId,
  });
  const fetchFactory = createProductionOriginBoundFetchFactory({
    timeoutMs: config.httpTimeoutMs,
    maxRequestBytes: MAX_OPERATOR_REQUEST_BYTES,
    maxResponseBytes: config.httpMaxResponseBytes,
  });
  const executorProxy = new PrivateExecutorAdministrationProxy(
    { executorOrigin: config.executorOrigin },
    new GoogleControlPlaneServiceIdentityTokenProvider(),
    fetchFactory,
  );
  const actionGuard = new FirestoreOperatorActionGuard(
    firestore,
    `${config.firestoreCollectionPrefix}_operator_actions`,
  );
  const incidentCaptureStore = new FirestoreOperatorIncidentCaptureStore(
    firestore,
    `${config.firestoreCollectionPrefix}_operator_captures`,
  );
  let flowPromise: ReturnType<typeof buildProductionControlPlaneLiveFlow> | undefined;
  return new OperatorControlPlaneBoundary(
    {
      auth,
      demoRunSlot: config.demoRunSlot,
      demoMandateId: config.demoMandateId,
    },
    {
      tokenVerifier: new GoogleOperatorOidcTokenVerifier(),
      executorProxy,
      actionGuard,
      incidentCaptureStore,
      buildLiveFlow: () => {
        flowPromise ??= buildProductionControlPlaneLiveFlow({ environment });
        return flowPromise;
      },
    },
  );
}

let productionBoundary: OperatorControlPlaneBoundary | undefined;

export function getProductionOperatorBoundary(): OperatorControlPlaneBoundary {
  productionBoundary ??= buildProductionOperatorBoundary();
  return productionBoundary;
}

export class OperatorHttpRequestError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    readonly code:
      | "operator_json_required"
      | "operator_request_too_large"
      | "operator_request_json_invalid",
  ) {
    super(code);
    this.name = "OperatorHttpRequestError";
  }
}

/** Bounded UTF-8/duplicate-key rejecting JSON reader for protected mutation routes. */
export async function readStrictOperatorJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    throw new OperatorHttpRequestError(415, "operator_json_required");
  }
  if (!request.body) {
    throw new OperatorHttpRequestError(400, "operator_request_json_invalid");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OPERATOR_REQUEST_BYTES) {
        await reader.cancel();
        throw new OperatorHttpRequestError(413, "operator_request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total < 1) {
    throw new OperatorHttpRequestError(400, "operator_request_json_invalid");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseStrictJson(text);
  } catch (error) {
    if (error instanceof OperatorHttpRequestError) throw error;
    throw new OperatorHttpRequestError(400, "operator_request_json_invalid");
  }
}

export function operatorJsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function operatorErrorResponse(error: unknown): Response {
  if (
    error instanceof OperatorAuthenticationError ||
    error instanceof OperatorBoundaryError ||
    error instanceof ExecutorAdministrationProxyError ||
    error instanceof OperatorHttpRequestError
  ) {
    return operatorJsonResponse({ error: error.code }, error.status);
  }
  return operatorJsonResponse({ error: "operator_boundary_unavailable" }, 503);
}
