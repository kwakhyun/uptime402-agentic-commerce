import "server-only";

import {
  IdentifierSchema,
  TimestampSchema,
  canonicalHash,
} from "@uptime402/domain";
import { z } from "zod";

import {
  LiveIncidentRequestSchema,
  type LiveIncidentRequest,
  type LiveIncidentResult,
} from "./live-flow.js";
import {
  authenticateOperator,
  type OperatorOidcAuthConfig,
  type OperatorOidcIdentity,
  type OperatorOidcTokenVerifier,
} from "./operator-auth.js";
import {
  ExecutorAdministrationProxyError,
  MandateAdministrationResponseSchema,
  OperatorArmMandateRequestSchema,
  OperatorRevokeMandateRequestSchema,
  type MandateAdministrationResponse,
  type PrivateExecutorAdministrationProxy,
} from "./operator-executor-proxy.js";
import {
  hashOperatorPrincipal,
  type OperatorActionClaimInput,
  type OperatorActionGuard,
  type OperatorActionRecord,
} from "./operator-guard.js";

const LiveIncidentInputWithoutOriginsSchema = LiveIncidentRequestSchema.omit({
  vendorAgentOrigin: true,
  executorOrigin: true,
});

export const OperatorRunIncidentRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    request: LiveIncidentInputWithoutOriginsSchema,
    denialRequests: z
      .object({
        expectedPerTransactionLimitBaseUnits: z.literal("20000"),
        overTransactionLimit: LiveIncidentInputWithoutOriginsSchema,
        replay: LiveIncidentInputWithoutOriginsSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const denials = value.denialRequests;
    if (!denials) return;
    const primary = value.request;
    const overCap = denials.overTransactionLimit;
    const replay = denials.replay;
    const commonComparisons = (
      denial: typeof overCap,
      pathPrefix: "overTransactionLimit" | "replay",
    ): ReadonlyArray<{
      valid: boolean;
      path: (string | number)[];
      message: string;
    }> => [
      {
        valid: denial.mandateId === primary.mandateId,
        path: ["denialRequests", pathPrefix, "mandateId"],
        message: "Denial proof must use the primary mandate",
      },
      {
        valid: denial.incident.id !== primary.incident.id,
        path: ["denialRequests", pathPrefix, "incident", "id"],
        message: "Denial proof incident ID must be distinct",
      },
      {
        valid: denial.idempotencyKey !== primary.idempotencyKey,
        path: ["denialRequests", pathPrefix, "idempotencyKey"],
        message: "Denial proof idempotency key must be distinct",
      },
      {
        valid: denial.operationId !== primary.operationId,
        path: ["denialRequests", pathPrefix, "operationId"],
        message: "Denial proof operation ID must be distinct for immutable storage",
      },
      {
        valid:
          denial.requiredCapability === primary.requiredCapability &&
          denial.subject === primary.subject,
        path: ["denialRequests", pathPrefix, "requiredCapability"],
        message: "Denial proof must preserve the primary capability and subject",
      },
      {
        valid:
          denial.executionPolicy.policyHash === primary.executionPolicy.policyHash,
        path: ["denialRequests", pathPrefix, "executionPolicy", "policyHash"],
        message: "Denial proof must use the same execution policy",
      },
    ];
    const comparisons: ReadonlyArray<{
      valid: boolean;
      path: (string | number)[];
      message: string;
    }> = [
      ...commonComparisons(overCap, "overTransactionLimit"),
      ...commonComparisons(replay, "replay"),
      {
        valid:
          overCap.paymentId !== primary.paymentId &&
          overCap.nonce !== primary.nonce &&
          overCap.paymentId !== replay.paymentId &&
          overCap.nonce !== replay.nonce,
        path: ["denialRequests", "overTransactionLimit", "paymentId"],
        message: "Over-cap proof must use fresh payment and nonce identifiers",
      },
      {
        valid:
          overCap.idempotencyKey !== replay.idempotencyKey &&
          overCap.incident.id !== replay.incident.id &&
          overCap.operationId !== replay.operationId,
        path: ["denialRequests", "overTransactionLimit"],
        message: "Automatic denial attempts must use distinct immutable identifiers",
      },
      {
        valid: replay.paymentId !== primary.paymentId,
        path: ["denialRequests", "replay", "paymentId"],
        message: "Nonce replay proof must use a fresh paymentId",
      },
      {
        valid: replay.nonce === primary.nonce,
        path: ["denialRequests", "replay", "nonce"],
        message: "Nonce replay proof must reuse the primary nonce",
      },
      {
        valid:
          replay.incident.service === primary.incident.service &&
          replay.incident.signal === primary.incident.signal &&
          replay.incident.healthBefore === primary.incident.healthBefore &&
          canonicalHash(replay.incident.rawTelemetry) ===
            canonicalHash(primary.incident.rawTelemetry),
        path: ["denialRequests", "replay", "incident", "rawTelemetry"],
        message: "Nonce replay proof must preserve the primary decision telemetry",
      },
      {
        valid:
          canonicalHash(overCap.incident.rawTelemetry) !==
          canonicalHash(primary.incident.rawTelemetry),
        path: ["denialRequests", "overTransactionLimit", "incident", "rawTelemetry"],
        message: "Over-cap proof must use counterfactual telemetry",
      },
    ];
    for (const comparison of comparisons) {
      if (!comparison.valid) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: comparison.path,
          message: comparison.message,
        });
      }
    }
  });

export type OperatorRunIncidentRequest = z.infer<
  typeof OperatorRunIncidentRequestSchema
>;

export type OperatorBoundaryConfig = Readonly<{
  auth: OperatorOidcAuthConfig;
  demoRunSlot: string;
  demoMandateId: string;
}>;

export type OperatorLiveFlow = Readonly<{
  config: Readonly<{
    vendorAgentOrigin: string;
    executorOrigin: string;
  }>;
  run(request: LiveIncidentRequest): Promise<LiveIncidentResult>;
}>;

export type OperatorBoundaryDependencies = Readonly<{
  tokenVerifier: OperatorOidcTokenVerifier;
  executorProxy: PrivateExecutorAdministrationProxy;
  actionGuard: OperatorActionGuard;
  incidentCaptureStore?: OperatorIncidentCaptureStore;
  buildLiveFlow: () => Promise<OperatorLiveFlow>;
  now?: () => string;
}>;

export class OperatorBoundaryError extends Error {
  constructor(
    readonly status: 400 | 409 | 502 | 503,
    readonly code:
      | "invalid_operator_request"
      | "demo_mandate_mismatch"
      | "operator_action_conflict"
      | "operator_action_in_progress"
      | "operator_action_failed_locked"
      | "operator_action_state_invalid"
      | "incident_run_failed_locked",
  ) {
    super(code);
    this.name = "OperatorBoundaryError";
  }
}

export type OperatorMandateMutationResult = Readonly<{
  schemaVersion: "1";
  separation: "application-role";
  idempotentReplay: boolean;
  result: MandateAdministrationResponse;
}>;

export type OperatorIncidentMutationResult =
  | Readonly<{
      schemaVersion: "1";
      separation: "application-role";
      idempotentReplay: false;
      result: {
        primary: LiveIncidentResult;
        denials: AutomaticDenialResults | null;
        denialBindings: AutomaticDenialBindings | null;
        denialBindingHashes: AutomaticDenialBindingHashes | null;
      };
    }>
  | Readonly<{
      schemaVersion: "1";
      separation: "application-role";
      idempotentReplay: true;
      result: {
        primary: {
          outcome: "recovered" | "denied" | "reconciliation_required";
          transactionCreated: boolean;
          txSignature: string | null;
          resultHash: `sha256:${string}`;
        };
        denials: AutomaticDenialSummaries | null;
        resultHash: `sha256:${string}`;
      };
    }>;

export type FreshOperatorIncidentMutationResult = Extract<
  OperatorIncidentMutationResult,
  { idempotentReplay: false }
>;

export type OperatorIncidentCaptureInput = Readonly<{
  runSlot: string;
  requestHash: `sha256:${string}`;
  capturedAt: string;
  response: FreshOperatorIncidentMutationResult;
}>;

export interface OperatorIncidentCaptureStore {
  create(input: OperatorIncidentCaptureInput): Promise<void>;
}

export type ReplayDenialBinding = Readonly<{
  identifierType: "nonce";
  mandateId: string;
  originalPaymentId: string;
  deniedPaymentId: string;
  originalIncidentId: string;
  deniedIncidentId: string;
  originalNonce: string;
  deniedNonce: string;
  originalIdempotencyKey: string;
  deniedIdempotencyKey: string;
  reasonCode: "identifier.nonce_fresh";
  transactionCreated: false;
  txSignature: null;
}>;

export type OverTransactionLimitDenialBinding = Readonly<{
  denialType: "perTransactionLimit";
  mandateId: string;
  deniedPaymentId: string;
  deniedIncidentId: string;
  deniedNonce: string;
  deniedIdempotencyKey: string;
  selectedOfferId: string;
  attemptedAmountBaseUnits: string;
  reasonCode: "amount.per_transaction_limit";
  transactionCreated: false;
  txSignature: null;
}>;

export type AutomaticDenialResults = Readonly<{
  overTransactionLimit: LiveIncidentResult;
  replay: LiveIncidentResult;
}>;

export type AutomaticDenialBindings = Readonly<{
  overTransactionLimit: OverTransactionLimitDenialBinding;
  replay: ReplayDenialBinding;
}>;

export type AutomaticDenialBindingHashes = Readonly<{
  overTransactionLimit: `sha256:${string}`;
  replay: `sha256:${string}`;
}>;

type AutomaticDenialSummaries = Readonly<{
  overTransactionLimit: {
    outcome: "denied";
    reasonCode: "amount.per_transaction_limit";
    transactionCreated: false;
    txSignature: null;
    resultHash: `sha256:${string}`;
    bindingHash: `sha256:${string}`;
  };
  replay: {
    outcome: "denied";
    reasonCode: "identifier.nonce_fresh";
    transactionCreated: false;
    txSignature: null;
    resultHash: `sha256:${string}`;
    bindingHash: `sha256:${string}`;
  };
}>;

function parsedNow(now: () => string): string {
  return TimestampSchema.parse(now());
}

function claimInput(input: {
  kind: OperatorActionClaimInput["kind"];
  subjectId: string;
  requestHash: `sha256:${string}`;
  identity: OperatorOidcIdentity;
  claimedAt: string;
}): OperatorActionClaimInput {
  return {
    kind: input.kind,
    subjectId: IdentifierSchema.parse(input.subjectId),
    requestHash: input.requestHash,
    principalHash: hashOperatorPrincipal(input.identity.principal),
    claimedAt: input.claimedAt,
  };
}

function existingActionError(record: OperatorActionRecord): never {
  if (record.state === "running") {
    throw new OperatorBoundaryError(409, "operator_action_in_progress");
  }
  if (record.state === "failed_locked") {
    throw new OperatorBoundaryError(409, "operator_action_failed_locked");
  }
  throw new OperatorBoundaryError(409, "operator_action_state_invalid");
}

function asRequestError(error: unknown): never {
  if (error instanceof z.ZodError) {
    throw new OperatorBoundaryError(400, "invalid_operator_request");
  }
  throw error;
}

/**
 * Application-role operator boundary. Human OIDC authentication happens here;
 * the private executor receives only the control-plane service identity.
 */
export class OperatorControlPlaneBoundary {
  private readonly now: () => string;

  constructor(
    readonly config: OperatorBoundaryConfig,
    private readonly dependencies: OperatorBoundaryDependencies,
  ) {
    this.config = Object.freeze({
      auth: config.auth,
      demoRunSlot: IdentifierSchema.parse(config.demoRunSlot),
      demoMandateId: IdentifierSchema.parse(config.demoMandateId),
    });
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  authenticate(authorizationHeader: string | null): Promise<OperatorOidcIdentity> {
    return authenticateOperator(
      authorizationHeader,
      this.config.auth,
      this.dependencies.tokenVerifier,
    );
  }

  async armMandate(
    identity: OperatorOidcIdentity,
    rawRequest: unknown,
  ): Promise<OperatorMandateMutationResult> {
    let request: z.infer<typeof OperatorArmMandateRequestSchema>;
    try {
      request = OperatorArmMandateRequestSchema.parse(rawRequest);
    } catch (error) {
      asRequestError(error);
    }
    const action = claimInput({
      kind: "mandate.arm",
      subjectId: request.mandate.id,
      requestHash: canonicalHash(request),
      identity,
      claimedAt: parsedNow(this.now),
    });
    const claimed = await this.dependencies.actionGuard.claim(action);
    if (claimed.kind === "conflict") {
      throw new OperatorBoundaryError(409, "operator_action_conflict");
    }
    if (claimed.kind === "existing") {
      if (
        claimed.record.state === "completed" &&
        claimed.record.summary.type === "mandate_administration"
      ) {
        return {
          schemaVersion: "1",
          separation: "application-role",
          idempotentReplay: true,
          result: MandateAdministrationResponseSchema.parse(
            claimed.record.summary.response,
          ),
        };
      }
      existingActionError(claimed.record);
    }

    try {
      const result = await this.dependencies.executorProxy.armMandate(request);
      await this.dependencies.actionGuard.complete(
        action,
        parsedNow(this.now),
        { type: "mandate_administration", response: result },
      );
      return {
        schemaVersion: "1",
        separation: "application-role",
        idempotentReplay: false,
        result,
      };
    } catch (error) {
      await this.dependencies.actionGuard.failLocked(
        action,
        parsedNow(this.now),
        error instanceof ExecutorAdministrationProxyError
          ? error.code
          : "executor_admin_unavailable",
      );
      throw error;
    }
  }

  async revokeMandate(
    identity: OperatorOidcIdentity,
    mandateId: string,
    rawRequest: unknown,
  ): Promise<OperatorMandateMutationResult> {
    let parsedMandateId: string;
    let request: z.infer<typeof OperatorRevokeMandateRequestSchema>;
    try {
      parsedMandateId = IdentifierSchema.parse(mandateId);
      request = OperatorRevokeMandateRequestSchema.parse(rawRequest);
    } catch (error) {
      asRequestError(error);
    }
    const action = claimInput({
      kind: "mandate.revoke",
      subjectId: parsedMandateId,
      requestHash: canonicalHash({ mandateId: parsedMandateId, request }),
      identity,
      claimedAt: parsedNow(this.now),
    });
    const claimed = await this.dependencies.actionGuard.claim(action);
    if (claimed.kind === "conflict") {
      throw new OperatorBoundaryError(409, "operator_action_conflict");
    }
    if (claimed.kind === "existing") {
      if (
        claimed.record.state === "completed" &&
        claimed.record.summary.type === "mandate_administration"
      ) {
        return {
          schemaVersion: "1",
          separation: "application-role",
          idempotentReplay: true,
          result: MandateAdministrationResponseSchema.parse(
            claimed.record.summary.response,
          ),
        };
      }
      existingActionError(claimed.record);
    }

    try {
      const result = await this.dependencies.executorProxy.revokeMandate(
        parsedMandateId,
        request,
      );
      await this.dependencies.actionGuard.complete(
        action,
        parsedNow(this.now),
        { type: "mandate_administration", response: result },
      );
      return {
        schemaVersion: "1",
        separation: "application-role",
        idempotentReplay: false,
        result,
      };
    } catch (error) {
      await this.dependencies.actionGuard.failLocked(
        action,
        parsedNow(this.now),
        error instanceof ExecutorAdministrationProxyError
          ? error.code
          : "executor_admin_unavailable",
      );
      throw error;
    }
  }

  async runIncident(
    identity: OperatorOidcIdentity,
    rawRequest: unknown,
  ): Promise<OperatorIncidentMutationResult> {
    let envelope: OperatorRunIncidentRequest;
    try {
      envelope = OperatorRunIncidentRequestSchema.parse(rawRequest);
    } catch (error) {
      asRequestError(error);
    }
    if (envelope.request.mandateId !== this.config.demoMandateId) {
      throw new OperatorBoundaryError(400, "demo_mandate_mismatch");
    }
    const action = claimInput({
      kind: "incident.run",
      subjectId: this.config.demoRunSlot,
      requestHash: canonicalHash(envelope),
      identity,
      claimedAt: parsedNow(this.now),
    });
    const claimed = await this.dependencies.actionGuard.claim(action);
    if (claimed.kind === "conflict") {
      throw new OperatorBoundaryError(409, "operator_action_conflict");
    }
    if (claimed.kind === "existing") {
      if (
        claimed.record.state === "completed" &&
        claimed.record.summary.type === "incident_result"
      ) {
        return {
          schemaVersion: "1",
          separation: "application-role",
          idempotentReplay: true,
          result: {
            primary: {
              ...claimed.record.summary.primary,
              resultHash: claimed.record.summary.primary.resultHash as `sha256:${string}`,
            },
            denials: claimed.record.summary.denials
              ? {
                  overTransactionLimit: {
                    ...claimed.record.summary.denials.overTransactionLimit,
                    resultHash: claimed.record.summary.denials.overTransactionLimit
                      .resultHash as `sha256:${string}`,
                    bindingHash: claimed.record.summary.denials.overTransactionLimit
                      .bindingHash as `sha256:${string}`,
                  },
                  replay: {
                    ...claimed.record.summary.denials.replay,
                    resultHash: claimed.record.summary.denials.replay
                      .resultHash as `sha256:${string}`,
                    bindingHash: claimed.record.summary.denials.replay
                      .bindingHash as `sha256:${string}`,
                  },
                }
              : null,
            resultHash: claimed.record.resultHash as `sha256:${string}`,
          },
        };
      }
      existingActionError(claimed.record);
    }

    try {
      const flow = await this.dependencies.buildLiveFlow();
      const liveRequest: LiveIncidentRequest = LiveIncidentRequestSchema.parse({
        ...envelope.request,
        vendorAgentOrigin: flow.config.vendorAgentOrigin,
        executorOrigin: flow.config.executorOrigin,
      });
      const primary = await flow.run(liveRequest);
      let denials: AutomaticDenialResults | null = null;
      let denialBindings: AutomaticDenialBindings | null = null;
      if (envelope.denialRequests && primary.outcome === "recovered") {
        const overCapLiveRequest = LiveIncidentRequestSchema.parse({
          ...envelope.denialRequests.overTransactionLimit,
          vendorAgentOrigin: flow.config.vendorAgentOrigin,
          executorOrigin: flow.config.executorOrigin,
        });
        const overTransactionLimit = await flow.run(overCapLiveRequest);
        const expectedLimit = BigInt(
          envelope.denialRequests.expectedPerTransactionLimitBaseUnits,
        );
        if (BigInt(primary.selectedOffer.payload.amountBaseUnits) > expectedLimit) {
          throw new Error(
            "Primary selected offer exceeds the server-owned P0 per-transaction preflight cap",
          );
        }
        if (
          overTransactionLimit.outcome !== "denied" ||
          overTransactionLimit.reasonCode !== "amount.per_transaction_limit" ||
          overTransactionLimit.transactionCreated !== false ||
          overTransactionLimit.txSignature !== null ||
          BigInt(overTransactionLimit.selectedOffer.payload.amountBaseUnits) <=
            expectedLimit
        ) {
          throw new Error("Automatic over-cap proof did not fail before transaction creation");
        }
        const replayLiveRequest = LiveIncidentRequestSchema.parse({
          ...envelope.denialRequests.replay,
          vendorAgentOrigin: flow.config.vendorAgentOrigin,
          executorOrigin: flow.config.executorOrigin,
        });
        const replay = await flow.run(replayLiveRequest);
        if (
          replay.outcome !== "denied" ||
          replay.reasonCode !== "identifier.nonce_fresh" ||
          replay.transactionCreated !== false ||
          replay.txSignature !== null ||
          replay.selectedOffer.payload.offerId !== primary.selectedOffer.payload.offerId ||
          replay.selectedOffer.payload.amountBaseUnits !==
            primary.selectedOffer.payload.amountBaseUnits
        ) {
          throw new Error("Automatic nonce-replay proof did not fail before transaction creation");
        }
        const overTransactionLimitBinding: OverTransactionLimitDenialBinding = {
          denialType: "perTransactionLimit",
          mandateId: envelope.request.mandateId,
          deniedPaymentId: envelope.denialRequests.overTransactionLimit.paymentId,
          deniedIncidentId: envelope.denialRequests.overTransactionLimit.incident.id,
          deniedNonce: envelope.denialRequests.overTransactionLimit.nonce,
          deniedIdempotencyKey:
            envelope.denialRequests.overTransactionLimit.idempotencyKey,
          selectedOfferId: overTransactionLimit.selectedOffer.payload.offerId,
          attemptedAmountBaseUnits:
            overTransactionLimit.selectedOffer.payload.amountBaseUnits,
          reasonCode: "amount.per_transaction_limit",
          transactionCreated: false,
          txSignature: null,
        };
        const replayBinding: ReplayDenialBinding = {
          identifierType: "nonce",
          mandateId: envelope.request.mandateId,
          originalPaymentId: envelope.request.paymentId,
          deniedPaymentId: envelope.denialRequests.replay.paymentId,
          originalIncidentId: envelope.request.incident.id,
          deniedIncidentId: envelope.denialRequests.replay.incident.id,
          originalNonce: envelope.request.nonce,
          deniedNonce: envelope.denialRequests.replay.nonce,
          originalIdempotencyKey: envelope.request.idempotencyKey,
          deniedIdempotencyKey: envelope.denialRequests.replay.idempotencyKey,
          reasonCode: "identifier.nonce_fresh",
          transactionCreated: false,
          txSignature: null,
        };
        denials = { overTransactionLimit, replay };
        denialBindings = {
          overTransactionLimit: overTransactionLimitBinding,
          replay: replayBinding,
        };
      }
      const response: FreshOperatorIncidentMutationResult = {
        schemaVersion: "1",
        separation: "application-role",
        idempotentReplay: false,
        result: {
          primary,
          denials,
          denialBindings,
          denialBindingHashes: denialBindings
            ? {
                overTransactionLimit: canonicalHash(
                  denialBindings.overTransactionLimit,
                ),
                replay: canonicalHash(denialBindings.replay),
              }
            : null,
        },
      };
      const terminalAt = parsedNow(this.now);
      await this.dependencies.incidentCaptureStore?.create({
        runSlot: this.config.demoRunSlot,
        requestHash: action.requestHash,
        capturedAt: terminalAt,
        response,
      });
      await this.dependencies.actionGuard.complete(action, terminalAt, {
        type: "incident_result",
        primary: {
          outcome: primary.outcome,
          transactionCreated: primary.transactionCreated,
          txSignature: primary.txSignature,
          resultHash: canonicalHash(primary),
        },
        denials: denials && denialBindings
          ? {
              overTransactionLimit: {
                outcome: "denied",
                reasonCode: "amount.per_transaction_limit",
                transactionCreated: false,
                txSignature: null,
                resultHash: canonicalHash(denials.overTransactionLimit),
                bindingHash: canonicalHash(denialBindings.overTransactionLimit),
              },
              replay: {
                outcome: "denied",
                reasonCode: "identifier.nonce_fresh",
                transactionCreated: false,
                txSignature: null,
                resultHash: canonicalHash(denials.replay),
                bindingHash: canonicalHash(denialBindings.replay),
              },
            }
          : null,
      });
      return response;
    } catch {
      await this.dependencies.actionGuard.failLocked(
        action,
        parsedNow(this.now),
        "live_flow_failed",
      );
      throw new OperatorBoundaryError(502, "incident_run_failed_locked");
    }
  }
}
