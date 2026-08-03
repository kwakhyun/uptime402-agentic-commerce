import "server-only";

import {
  IdentifierSchema,
  MandateSchema,
  TimestampSchema,
  canonicalHash,
  canonicalize,
  computeMandateHash,
  normalizePinnedOrigin,
  type Mandate,
} from "@uptime402/domain";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";

import type { OriginBoundFetchFactory } from "./pinned-fetch.js";
import { parseStrictJson } from "./strict-json.js";

const MAX_EXECUTOR_ADMIN_RESPONSE_BYTES = 64 * 1024;

export const OperatorArmMandateRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    mandate: MandateSchema,
  })
  .strict();

export const OperatorRevokeMandateRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    revokedAt: TimestampSchema,
    reason: z.string().min(1).max(500),
  })
  .strict();

export type OperatorArmMandateRequest = z.infer<typeof OperatorArmMandateRequestSchema>;
export type OperatorRevokeMandateRequest = z.infer<
  typeof OperatorRevokeMandateRequestSchema
>;

export const MandateAdministrationResponseSchema = z
  .object({
    mandateId: IdentifierSchema,
    version: z.number().int().positive(),
    event: z.enum(["armed", "revoked"]),
    at: TimestampSchema,
    separation: z.literal("application-role"),
  })
  .strict();

export type MandateAdministrationResponse = z.infer<
  typeof MandateAdministrationResponseSchema
>;

export interface ControlPlaneServiceIdentityTokenProvider {
  getIdToken(exactAudience: string): Promise<string>;
}

/** Uses the attached control-plane service account; it never reads a key file. */
export class GoogleControlPlaneServiceIdentityTokenProvider
  implements ControlPlaneServiceIdentityTokenProvider
{
  constructor(private readonly auth = new GoogleAuth()) {}

  async getIdToken(exactAudience: string): Promise<string> {
    const client = await this.auth.getIdTokenClient(exactAudience);
    const token = await client.idTokenProvider.fetchIdToken(exactAudience);
    if (!token || /\s/u.test(token)) {
      throw new Error("Unable to obtain a Google-signed executor identity token");
    }
    return token;
  }
}

export class ExecutorAdministrationProxyError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502 | 503,
    readonly code:
      | "executor_admin_request_rejected"
      | "executor_mandate_not_found"
      | "executor_admin_conflict"
      | "executor_service_identity_rejected"
      | "executor_admin_unavailable"
      | "executor_admin_response_invalid",
  ) {
    super(code);
    this.name = "ExecutorAdministrationProxyError";
  }
}

export type PrivateExecutorAdministrationProxyConfig = Readonly<{
  executorOrigin: string;
}>;

async function readExecutorJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new ExecutorAdministrationProxyError(502, "executor_admin_response_invalid");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_EXECUTOR_ADMIN_RESPONSE_BYTES) {
    throw new ExecutorAdministrationProxyError(502, "executor_admin_response_invalid");
  }
  try {
    return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ExecutorAdministrationProxyError(502, "executor_admin_response_invalid");
  }
}

function mapExecutorFailure(status: number): ExecutorAdministrationProxyError {
  if (status === 400) {
    return new ExecutorAdministrationProxyError(400, "executor_admin_request_rejected");
  }
  if (status === 404) {
    return new ExecutorAdministrationProxyError(404, "executor_mandate_not_found");
  }
  if (status === 409) {
    return new ExecutorAdministrationProxyError(409, "executor_admin_conflict");
  }
  if (status === 401 || status === 403) {
    return new ExecutorAdministrationProxyError(
      502,
      "executor_service_identity_rejected",
    );
  }
  return new ExecutorAdministrationProxyError(503, "executor_admin_unavailable");
}

export class PrivateExecutorAdministrationProxy {
  readonly executorOrigin: string;

  constructor(
    config: PrivateExecutorAdministrationProxyConfig,
    private readonly identityTokenProvider: ControlPlaneServiceIdentityTokenProvider,
    private readonly fetchFactory: OriginBoundFetchFactory,
  ) {
    this.executorOrigin = normalizePinnedOrigin(config.executorOrigin);
  }

  async armMandate(
    rawRequest: OperatorArmMandateRequest,
  ): Promise<MandateAdministrationResponse> {
    const request = OperatorArmMandateRequestSchema.parse(rawRequest);
    if (request.mandate.mandateHash !== computeMandateHash(request.mandate)) {
      throw new ExecutorAdministrationProxyError(
        400,
        "executor_admin_request_rejected",
      );
    }
    const result = await this.send(
      "/v1/operator/mandates/arm",
      { mandate: request.mandate },
    );
    const response = MandateAdministrationResponseSchema.parse(result);
    if (response.event !== "armed" || response.mandateId !== request.mandate.id) {
      throw new ExecutorAdministrationProxyError(502, "executor_admin_response_invalid");
    }
    return response;
  }

  async revokeMandate(
    mandateId: string,
    rawRequest: OperatorRevokeMandateRequest,
  ): Promise<MandateAdministrationResponse> {
    const parsedMandateId = IdentifierSchema.parse(mandateId);
    const request = OperatorRevokeMandateRequestSchema.parse(rawRequest);
    const result = await this.send(
      `/v1/operator/mandates/${encodeURIComponent(parsedMandateId)}/revoke`,
      { revokedAt: request.revokedAt, reason: request.reason },
    );
    const response = MandateAdministrationResponseSchema.parse(result);
    if (response.event !== "revoked" || response.mandateId !== parsedMandateId) {
      throw new ExecutorAdministrationProxyError(502, "executor_admin_response_invalid");
    }
    return response;
  }

  private async send(path: string, body: { mandate: Mandate } | {
    revokedAt: string;
    reason: string;
  }): Promise<unknown> {
    const bodyText = canonicalize(body);
    const actionHash = canonicalHash({ method: "POST", path, body });
    let token: string;
    try {
      token = await this.identityTokenProvider.getIdToken(this.executorOrigin);
    } catch {
      throw new ExecutorAdministrationProxyError(503, "executor_admin_unavailable");
    }
    let response: Response;
    try {
      response = await this.fetchFactory.forOrigin(this.executorOrigin)(
        `${this.executorOrigin}${path}`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-uptime402-action-hash": actionHash,
            "x-uptime402-separation": "application-role",
          },
          body: bodyText,
        },
      );
    } catch (error) {
      if (error instanceof ExecutorAdministrationProxyError) throw error;
      throw new ExecutorAdministrationProxyError(503, "executor_admin_unavailable");
    }
    if (response.status < 200 || response.status > 299) {
      throw mapExecutorFailure(response.status);
    }
    return readExecutorJson(response);
  }
}
