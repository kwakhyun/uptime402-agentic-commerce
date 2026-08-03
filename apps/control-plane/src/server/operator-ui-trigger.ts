import "server-only";

import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  Sha256Schema,
  createIncidentRunBindingHash,
  normalizePinnedOrigin,
} from "@uptime402/domain";
import { z } from "zod";

import {
  LIVE_OPERATOR_EVENT_KINDS,
  type LiveOperatorUiConfig,
  type LiveOperatorUiResponse,
} from "../live-ui-contract.js";
import {
  OperatorRunIncidentRequestSchema,
  type OperatorIncidentMutationResult,
  type OperatorRunIncidentRequest,
} from "./operator-boundary.js";
import { parseStrictJson } from "./strict-json.js";

const MAX_DEMO_REQUEST_BYTES = 512 * 1024;
const GOOGLE_WEB_CLIENT_ID = /^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/u;

const LiveOperatorEventProjectionSchema = z
  .object({
    phase: z.enum(["primary", "overTransactionLimit", "replay"]),
    sequence: z.number().int().positive(),
    correlationId: z.string().min(1).max(128),
    kind: z.enum(LIVE_OPERATOR_EVENT_KINDS),
    occurredAt: z.string().datetime({ offset: true }),
    protocolLabel: z.string().min(1).max(128),
    transactionCreated: z.boolean(),
  })
  .strict();

const LiveOperatorUiResponseSchema = z
  .object({
    schemaVersion: z.literal("1"),
    evidenceLevel: z.literal("live-unverified"),
    separation: z.literal("application-role"),
    runBindingHash: Sha256Schema,
    idempotentReplay: z.boolean(),
    primary: z
      .object({
        outcome: z.enum(["recovered", "denied", "reconciliation_required"]),
        transactionCreated: z.boolean(),
        reasonCode: z.string().min(1).max(256).optional(),
      })
      .strict(),
    denials: z
      .object({
        overTransactionLimit: z
          .object({
            outcome: z.literal("denied"),
            reasonCode: z.literal("amount.per_transaction_limit"),
            transactionCreated: z.literal(false),
          })
          .strict(),
        replay: z
          .object({
            outcome: z.literal("denied"),
            reasonCode: z.literal("identifier.nonce_fresh"),
            transactionCreated: z.literal(false),
          })
          .strict(),
      })
      .strict()
      .nullable(),
    events: z.array(LiveOperatorEventProjectionSchema).max(64),
  })
  .strict();

type EnabledLiveUiConfig = Readonly<{
  mode: "google-oidc-live";
  clientId: string;
  audience: string;
  controlPlaneOrigin: string;
  requestPath: string;
  requestRoot: string;
}>;

function required(environment: Readonly<NodeJS.ProcessEnv>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function isInsideRoot(candidate: string, root: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function parseEnabledConfig(
  environment: Readonly<NodeJS.ProcessEnv>,
): EnabledLiveUiConfig {
  const clientId = required(environment, "CONTROL_PLANE_UI_GOOGLE_CLIENT_ID");
  const audience = required(environment, "CONTROL_PLANE_OPERATOR_AUDIENCE");
  if (!GOOGLE_WEB_CLIENT_ID.test(clientId)) {
    throw new TypeError("CONTROL_PLANE_UI_GOOGLE_CLIENT_ID must be a Google OAuth Web client ID");
  }
  if (clientId !== audience) {
    throw new TypeError(
      "CONTROL_PLANE_UI_GOOGLE_CLIENT_ID must exactly equal CONTROL_PLANE_OPERATOR_AUDIENCE",
    );
  }
  const requestPath = required(environment, "CONTROL_PLANE_UI_LIVE_REQUEST_PATH");
  const requestRoot = required(environment, "CONTROL_PLANE_UI_LIVE_REQUEST_ROOT");
  if (!isAbsolute(requestPath) || !isAbsolute(requestRoot)) {
    throw new TypeError("Live UI request path and root must be absolute");
  }
  return Object.freeze({
    mode: "google-oidc-live",
    clientId,
    audience,
    controlPlaneOrigin: normalizePinnedOrigin(
      required(environment, "CONTROL_PLANE_ORIGIN"),
    ),
    requestPath: resolve(requestPath),
    requestRoot: resolve(requestRoot),
  });
}

export function parseLiveOperatorUiConfig(
  environment: Readonly<NodeJS.ProcessEnv>,
): LiveOperatorUiConfig {
  const enabled = environment.CONTROL_PLANE_UI_LIVE_TRIGGER_ENABLED?.trim();
  if (!enabled || enabled === "false") return Object.freeze({ mode: "disabled" });
  if (enabled !== "true") {
    throw new TypeError("CONTROL_PLANE_UI_LIVE_TRIGGER_ENABLED must be true or false");
  }
  const config = parseEnabledConfig(environment);
  return Object.freeze({
    mode: config.mode,
    clientId: config.clientId,
    audience: config.audience,
  });
}

export function requireLiveOperatorUiConfig(
  environment: Readonly<NodeJS.ProcessEnv>,
): EnabledLiveUiConfig {
  if (environment.CONTROL_PLANE_UI_LIVE_TRIGGER_ENABLED?.trim() !== "true") {
    throw new OperatorLiveUiHttpError(404, "operator_live_trigger_disabled");
  }
  return parseEnabledConfig(environment);
}

/**
 * Reads only a server-configured immutable file. Cloud Run secret-volume
 * symlink indirection is allowed after realpath containment; the resolved
 * target must be a bounded, owner-readable, non-writable regular file.
 */
export async function readServerOwnedIncidentRequest(
  config: Pick<EnabledLiveUiConfig, "requestPath" | "requestRoot">,
): Promise<OperatorRunIncidentRequest> {
  const [resolvedRoot, resolvedPath] = await Promise.all([
    realpath(config.requestRoot),
    realpath(config.requestPath),
  ]);
  if (!isInsideRoot(resolvedPath, resolvedRoot)) {
    throw new Error("Live UI request resolves outside its configured root");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(resolvedPath, fsConstants.O_RDONLY | noFollow);
  let bytes: Buffer | undefined;
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > MAX_DEMO_REQUEST_BYTES ||
      (stat.mode & 0o400) === 0 ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new Error(
        "Live UI request must be a bounded owner-readable, non-writable regular file",
      );
    }
    if (
      typeof process.getuid === "function" &&
      stat.uid !== process.getuid() &&
      stat.uid !== 0
    ) {
      throw new Error("Live UI request must be owned by the runtime user or root");
    }
    bytes = Buffer.allocUnsafe(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, stat.size, 0);
    if (bytesRead !== stat.size) throw new Error("Live UI request read was incomplete");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return OperatorRunIncidentRequestSchema.parse(parseStrictJson(text));
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

export class OperatorLiveUiHttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly code:
      | "operator_live_trigger_disabled"
      | "operator_live_origin_forbidden"
      | "operator_live_request_body_forbidden",
  ) {
    super(code);
    this.name = "OperatorLiveUiHttpError";
  }
}

/** Requires a non-ambient Authorization request from this exact public origin. */
export function assertSameOriginBodylessLiveRequest(
  request: Request,
  expectedOrigin: string,
): void {
  const normalizedExpected = normalizePinnedOrigin(expectedOrigin);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const referer = request.headers.get("referer");
  let refererOrigin: string | null = null;
  if (referer) {
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      refererOrigin = null;
    }
  }
  // Chrome and Google Frontend may respectively omit Origin/Fetch Metadata,
  // expose an opaque Origin, or reconstruct Request.url from the container
  // listener. Require the browser-controlled exact public Referer whenever an
  // exact Origin is unavailable; contradictory cross-site metadata remains
  // rejected before the separate non-ambient OIDC bearer authentication.
  const browserSameOriginFallback =
    (origin === null || origin === "null" || origin === normalizedExpected) &&
    (fetchSite === null ||
      fetchSite === "same-origin" ||
      fetchSite === "same-site") &&
    refererOrigin === normalizedExpected;
  if (
    (origin !== normalizedExpected && !browserSameOriginFallback) ||
    fetchSite === "cross-site"
  ) {
    throw new OperatorLiveUiHttpError(403, "operator_live_origin_forbidden");
  }
  const contentLength = request.headers.get("content-length");
  if (
    request.headers.has("content-type") ||
    request.headers.has("transfer-encoding") ||
    (contentLength !== null && contentLength !== "0")
  ) {
    throw new OperatorLiveUiHttpError(400, "operator_live_request_body_forbidden");
  }
}

function projectEvents(
  phase: "primary" | "overTransactionLimit" | "replay",
  value: unknown,
): z.infer<typeof LiveOperatorEventProjectionSchema>[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const event = z
      .object({
        sequence: z.number().int().positive(),
        correlationId: z.string().min(1).max(128),
        kind: z.enum(LIVE_OPERATOR_EVENT_KINDS),
        occurredAt: z.string().datetime({ offset: true }),
        protocolLabel: z.string().min(1).max(128),
        evidenceLevel: z.literal("live-unverified"),
        transactionCreated: z.boolean(),
      })
      .passthrough()
      .parse(raw);
    return LiveOperatorEventProjectionSchema.parse({
      phase,
      sequence: event.sequence,
      correlationId: event.correlationId,
      kind: event.kind,
      occurredAt: event.occurredAt,
      protocolLabel: event.protocolLabel,
      transactionCreated: event.transactionCreated,
    });
  });
}

export function projectLiveOperatorUiResponse(
  mutation: OperatorIncidentMutationResult,
  runBindingHash: `sha256:${string}`,
): LiveOperatorUiResponse {
  if (mutation.idempotentReplay) {
    return LiveOperatorUiResponseSchema.parse({
      schemaVersion: "1",
      evidenceLevel: "live-unverified",
      separation: mutation.separation,
      runBindingHash,
      idempotentReplay: true,
      primary: {
        outcome: mutation.result.primary.outcome,
        transactionCreated: mutation.result.primary.transactionCreated,
      },
      denials: mutation.result.denials
        ? {
            overTransactionLimit: {
              outcome: mutation.result.denials.overTransactionLimit.outcome,
              reasonCode:
                mutation.result.denials.overTransactionLimit.reasonCode,
              transactionCreated:
                mutation.result.denials.overTransactionLimit.transactionCreated,
            },
            replay: {
              outcome: mutation.result.denials.replay.outcome,
              reasonCode: mutation.result.denials.replay.reasonCode,
              transactionCreated: mutation.result.denials.replay.transactionCreated,
            },
          }
        : null,
      events: [],
    }) as LiveOperatorUiResponse;
  }

  const primary = mutation.result.primary;
  if (primary.evidence.level !== "live-unverified") {
    throw new Error("Live UI route refuses non-live execution evidence labels");
  }
  const denials = mutation.result.denials;
  if (
    denials &&
    (denials.overTransactionLimit.evidence.level !== "live-unverified" ||
      denials.replay.evidence.level !== "live-unverified")
  ) {
    throw new Error("Live UI route refuses non-live denial evidence labels");
  }
  const reasonCode = primary.outcome === "recovered" ? undefined : primary.reasonCode;
  return LiveOperatorUiResponseSchema.parse({
    schemaVersion: "1",
    evidenceLevel: "live-unverified",
    separation: mutation.separation,
    runBindingHash,
    idempotentReplay: false,
    primary: {
      outcome: primary.outcome,
      transactionCreated: primary.transactionCreated,
      ...(reasonCode ? { reasonCode } : {}),
    },
    denials: denials
      ? {
          overTransactionLimit: {
            outcome: "denied",
            reasonCode: "amount.per_transaction_limit",
            transactionCreated: false,
          },
          replay: {
            outcome: "denied",
            reasonCode: "identifier.nonce_fresh",
            transactionCreated: false,
          },
        }
      : null,
    events: [
      ...projectEvents("primary", primary.events),
      ...(denials
        ? projectEvents(
            "overTransactionLimit",
            denials.overTransactionLimit.events,
          )
        : []),
      ...(denials ? projectEvents("replay", denials.replay.events) : []),
    ],
  }) as LiveOperatorUiResponse;
}

export function hashServerOwnedIncidentRunBinding(
  request: OperatorRunIncidentRequest,
): `sha256:${string}` {
  const primary = request.request;
  return createIncidentRunBindingHash({
    incidentId: primary.incident.id,
    mandateId: primary.mandateId,
    operationId: primary.operationId,
    paymentId: primary.paymentId,
    nonce: primary.nonce,
    idempotencyKey: primary.idempotencyKey,
    executionPolicyHash: primary.executionPolicy.policyHash,
  });
}
