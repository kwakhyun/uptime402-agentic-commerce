import {
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  MandateUnsignedSchema,
  computeExecutionPolicyHash,
  computeMandateHash,
  createNetworkIdentity,
  omitKeys,
  type Mandate,
} from "@uptime402/domain";
import {
  verifyCanonicalEd25519Signature,
} from "@uptime402/payments";
import { generateKeyPairSigner } from "@solana/kit";
import type { OAuth2Client } from "google-auth-library";
import { describe, expect, it, vi } from "vitest";

import {
  GoogleOperatorOidcTokenVerifier,
  authenticateOperator,
  parseOperatorOidcAuthConfig,
  type OperatorOidcIdentity,
  type OperatorOidcTokenVerifier,
} from "../apps/control-plane/src/server/operator-auth.js";
import {
  OperatorControlPlaneBoundary,
  OperatorRunIncidentRequestSchema,
  type OperatorIncidentCaptureInput,
} from "../apps/control-plane/src/server/operator-boundary.js";
import {
  PrivateExecutorAdministrationProxy,
  type ControlPlaneServiceIdentityTokenProvider,
} from "../apps/control-plane/src/server/operator-executor-proxy.js";
import { InMemoryOperatorActionGuard } from "../apps/control-plane/src/server/operator-guard.js";
import {
  parseProductionOperatorBoundaryRuntimeConfig,
  readStrictOperatorJson,
  requireOperatorMutationsEnabled,
} from "../apps/control-plane/src/server/operator-runtime.js";
import type {
  LiveIncidentRequest,
  LiveIncidentResult,
} from "../apps/control-plane/src/server/live-flow.js";
import type { OriginBoundFetchFactory } from "../apps/control-plane/src/server/pinned-fetch.js";
import { buildSignedMandate } from "../scripts/mandate-sign.js";
import { parseMandateJson } from "../scripts/mandate-json.js";

const OPERATOR_AUDIENCE = "https://control.uptime402.example";
const EXECUTOR_ORIGIN = "https://executor.uptime402.example";
const OPERATOR_PRINCIPAL = "sre@example.com";
const KEY_A = "11111111111111111111111111111111";
const KEY_B = "SysvarRent111111111111111111111111111111111";

const identity: OperatorOidcIdentity = {
  audience: OPERATOR_AUDIENCE,
  principal: OPERATOR_PRINCIPAL,
  subject: "google-subject-1",
  issuer: "https://accounts.google.com",
};

function makeMandate(): Mandate {
  const unsigned = MandateUnsignedSchema.parse({
    id: "mandate-demo",
    subject: "service:checkout",
    clusterLabel: "devnet",
    assetMint: DEVNET_USDC_MINT,
    perTransactionLimitBaseUnits: "20000",
    incidentLimitBaseUnits: "50000",
    dailyLimitBaseUnits: "50000",
    allowedRecipients: [KEY_B],
    allowedCapabilities: ["solana-rpc-health"],
    allowedVendorOrigins: ["https://vendor.uptime402.example"],
    allowedAgentCardHashes: [`sha256:${"a".repeat(64)}`],
    notBefore: "2026-08-03T01:00:00.000Z",
    expiresAt: "2026-08-03T01:10:00.000Z",
    nonce: "mandate-nonce-demo",
    issuerPrincipal: "operator:uptime402",
    issuedAt: "2026-08-03T01:00:00.000Z",
    executionPolicyHash: `sha256:${"b".repeat(64)}`,
    protocolLabel: "ap2-aligned",
  });
  return {
    ...unsigned,
    mandateHash: computeMandateHash(unsigned),
    attestation: {
      kid: "mandate-v1",
      algorithm: "EdDSA",
      signature: "T".repeat(88),
    },
  };
}

function fixedTokenVerifier(
  overrides: Partial<OperatorOidcIdentity> = {},
): OperatorOidcTokenVerifier {
  return {
    async verifyBearerToken() {
      return { ...identity, ...overrides };
    },
  };
}

function proxyFixture() {
  const calls: Array<{
    url: string;
    init?: RequestInit;
  }> = [];
  const tokenProvider: ControlPlaneServiceIdentityTokenProvider = {
    getIdToken: vi.fn(async (audience: string) => {
      expect(audience).toBe(EXECUTOR_ORIGIN);
      return "control.service.token";
    }),
  };
  const fetchFactory: OriginBoundFetchFactory = {
    mode: "production-pinned-https",
    forOrigin(origin) {
      expect(origin).toBe(EXECUTOR_ORIGIN);
      return (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(
          init === undefined
            ? { url: String(input) }
            : { url: String(input), init },
        );
        const path = new URL(String(input)).pathname;
        const event = path.endsWith("/revoke") ? "revoked" : "armed";
        return new Response(
          JSON.stringify({
            mandateId: "mandate-demo",
            version: 1,
            event,
            at: "2026-08-03T01:00:01.000Z",
            separation: "application-role",
          }),
          { status: event === "armed" ? 201 : 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
    },
  };
  return {
    proxy: new PrivateExecutorAdministrationProxy(
      { executorOrigin: EXECUTOR_ORIGIN },
      tokenProvider,
      fetchFactory,
    ),
    calls,
    tokenProvider,
  };
}

function makeRunEnvelope(idempotencyKey = "idempotency-demo") {
  const policyUnsigned = {
    id: "policy-demo",
    version: 1,
    network: createNetworkIdentity({
      clusterLabel: "devnet",
      genesisHash: DEVNET_GENESIS_HASH,
      sdkNetworkId: DEVNET_X402_NETWORK_ID,
    }),
    assetMint: DEVNET_USDC_MINT,
    assetDecimals: 6 as const,
    executorPublicKey: KEY_A,
    feePayer: KEY_A,
    maxNetworkFeeLamports: "100000",
    allowedProgramIds: [KEY_A],
    allowedAccountRules: [KEY_A],
    allowedFacilitatorOrigins: ["https://facilitator.uptime402.example"],
    maxResponseBytes: 1_048_576,
  };
  return {
    schemaVersion: "1" as const,
    request: {
      incident: {
        id: "incident-demo",
        service: "checkout-api",
        signal: "rpc-timeout",
        observedAt: "2026-08-03T01:00:00.000Z",
        healthBefore: "down" as const,
        rawTelemetry: {
          errorClass: "TIMEOUT",
          statusCode: 503,
          latencyMs: 5000,
          failureRate: 1,
          message: "upstream timeout",
        },
      },
      requiredCapability: "solana-rpc-health",
      mandateId: "mandate-demo",
      subject: "service:checkout",
      operationId: "operation-demo",
      paymentId: "payment-demo",
      nonce: "payment-nonce-demo",
      idempotencyKey,
      executionPolicy: {
        ...policyUnsigned,
        policyHash: computeExecutionPolicyHash(policyUnsigned),
      },
    },
  };
}

function deniedResult(
  reasonCode = "amount.per_transaction_limit",
  offerId = "rpc-over-cap",
  amountBaseUnits = "21000",
): LiveIncidentResult {
  return {
    outcome: "denied",
    reasonCode,
    transactionCreated: false,
    txSignature: null,
    incident: {},
    selectedOffer: { payload: { offerId, amountBaseUnits } },
    events: [],
    evidence: { level: "live-unverified", explorerUrl: null, tokenDeltas: [] },
  } as unknown as LiveIncidentResult;
}

function recoveredResult(): LiveIncidentResult {
  return {
    outcome: "recovered",
    transactionCreated: true,
    txSignature: "2".repeat(88),
    reservationId: "reservation-demo",
    incident: {},
    decision: {},
    offers: [{}, {}],
    selectedOffer: {
      payload: { offerId: "rpc-primary", amountBaseUnits: "18000" },
    },
    events: [],
    evidence: { level: "live-unverified", explorerUrl: null, tokenDeltas: [] },
  } as unknown as LiveIncidentResult;
}

function replayDeniedResult(): LiveIncidentResult {
  return deniedResult("identifier.nonce_fresh", "rpc-primary", "18000");
}

function makeDualDenialEnvelope() {
  const primaryEnvelope = makeRunEnvelope();
  return {
    ...primaryEnvelope,
    denialRequests: {
      expectedPerTransactionLimitBaseUnits: "20000" as const,
      overTransactionLimit: {
        ...primaryEnvelope.request,
        incident: {
          ...primaryEnvelope.request.incident,
          id: "incident-over-cap-denial",
          observedAt: "2026-08-03T01:00:04.000Z",
          rawTelemetry: {
            ...primaryEnvelope.request.incident.rawTelemetry,
            latencyMs: 100,
            failureRate: 0.2,
          },
        },
        operationId: "operation-over-cap-denial",
        paymentId: "payment-over-cap-denial",
        nonce: "payment-nonce-over-cap-denial",
        idempotencyKey: "idempotency-over-cap-denial",
      },
      replay: {
        ...primaryEnvelope.request,
        incident: {
          ...primaryEnvelope.request.incident,
          id: "incident-nonce-replay-denial",
          observedAt: "2026-08-03T01:00:05.000Z",
        },
        operationId: "operation-nonce-replay-denial",
        paymentId: "payment-nonce-replay-denial",
        idempotencyKey: "idempotency-nonce-replay-denial",
      },
    },
  };
}

describe("Google OIDC operator authentication", () => {
  it("checks the exact audience, verified email, and allowlisted principal", async () => {
    const verifyIdToken = vi.fn(async () => ({
      getPayload: () => ({
        aud: OPERATOR_AUDIENCE,
        iss: "https://accounts.google.com",
        sub: "google-subject-1",
        email: OPERATOR_PRINCIPAL,
        email_verified: true,
      }),
    }));
    const verifier = new GoogleOperatorOidcTokenVerifier({
      verifyIdToken,
    } as unknown as OAuth2Client);
    await expect(
      authenticateOperator(
        "Bearer header.payload.signature",
        { audience: OPERATOR_AUDIENCE, allowedPrincipals: [OPERATOR_PRINCIPAL] },
        verifier,
      ),
    ).resolves.toMatchObject({ principal: OPERATOR_PRINCIPAL });
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: "header.payload.signature",
      audience: OPERATOR_AUDIENCE,
    });
  });

  it("rejects missing, wrong-audience, and non-allowlisted operator tokens", async () => {
    await expect(
      authenticateOperator(
        null,
        { audience: OPERATOR_AUDIENCE, allowedPrincipals: [OPERATOR_PRINCIPAL] },
        fixedTokenVerifier(),
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "operator_token_required",
    });
    await expect(
      authenticateOperator(
        "Bearer header.payload.signature",
        { audience: OPERATOR_AUDIENCE, allowedPrincipals: [OPERATOR_PRINCIPAL] },
        fixedTokenVerifier({ audience: "https://other.example" }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "operator_audience_mismatch" });
    await expect(
      authenticateOperator(
        "Bearer header.payload.signature",
        { audience: OPERATOR_AUDIENCE, allowedPrincipals: ["other@example.com"] },
        fixedTokenVerifier(),
      ),
    ).rejects.toMatchObject({ status: 403, code: "operator_principal_forbidden" });
  });

  it("parses only an explicit exact audience and distinct principal list", () => {
    expect(
      parseOperatorOidcAuthConfig({
        NODE_ENV: "test",
        CONTROL_PLANE_OPERATOR_AUDIENCE: OPERATOR_AUDIENCE,
        CONTROL_PLANE_OPERATOR_PRINCIPALS: `${OPERATOR_PRINCIPAL},backup@example.com`,
      }),
    ).toEqual({
      audience: OPERATOR_AUDIENCE,
      allowedPrincipals: [OPERATOR_PRINCIPAL, "backup@example.com"],
    });
    expect(() =>
      parseOperatorOidcAuthConfig({
        NODE_ENV: "test",
        CONTROL_PLANE_OPERATOR_AUDIENCE: OPERATOR_AUDIENCE,
        CONTROL_PLANE_OPERATOR_PRINCIPALS: `${OPERATOR_PRINCIPAL},${OPERATOR_PRINCIPAL}`,
      }),
    ).toThrow(/distinct/);
  });
});

describe("private executor mandate administration proxy", () => {
  it("replaces the human token with the control-plane service identity", async () => {
    const fixture = proxyFixture();
    const mandate = makeMandate();
    await expect(
      fixture.proxy.armMandate({ schemaVersion: "1", mandate }),
    ).resolves.toMatchObject({ event: "armed", separation: "application-role" });
    expect(fixture.calls).toHaveLength(1);
    const call = fixture.calls[0]!;
    expect(new Headers(call.init?.headers).get("authorization")).toBe(
      "Bearer control.service.token",
    );
    expect(call.init?.redirect).toBe("error");
    expect(JSON.parse(String(call.init?.body))).toEqual({ mandate });
    expect(String(call.init?.body)).not.toContain("schemaVersion");
    expect(String(call.init?.body)).not.toContain("header.payload.signature");
  });

  it("strictly rejects secret-bearing or unversioned mandate requests before fetch", async () => {
    const fixture = proxyFixture();
    await expect(
      fixture.proxy.armMandate({
        schemaVersion: "1",
        mandate: makeMandate(),
        privateKey: "must-never-be-accepted",
      } as unknown as Parameters<typeof fixture.proxy.armMandate>[0]),
    ).rejects.toThrow();
    expect(fixture.calls).toHaveLength(0);
  });

  it("proxies the versioned kill switch through the same service identity", async () => {
    const fixture = proxyFixture();
    await expect(
      fixture.proxy.revokeMandate("mandate-demo", {
        schemaVersion: "1",
        revokedAt: "2026-08-03T01:00:03.000Z",
        reason: "operator kill switch",
      }),
    ).resolves.toMatchObject({ event: "revoked", mandateId: "mandate-demo" });
    const call = fixture.calls[0]!;
    expect(call.url).toBe(`${EXECUTOR_ORIGIN}/v1/operator/mandates/mandate-demo/revoke`);
    expect(new Headers(call.init?.headers).get("authorization")).toBe(
      "Bearer control.service.token",
    );
    expect(JSON.parse(String(call.init?.body))).toEqual({
      revokedAt: "2026-08-03T01:00:03.000Z",
      reason: "operator kill switch",
    });
  });
});

describe("one-shot authenticated incident boundary", () => {
  it("runs once, then returns a terminal summary without invoking the flow again", async () => {
    const fixture = proxyFixture();
    const run = vi.fn(async (_input: LiveIncidentRequest) => deniedResult());
    const buildLiveFlow = vi.fn(async () => ({
      config: {
        vendorAgentOrigin: "https://vendor.uptime402.example",
        executorOrigin: EXECUTOR_ORIGIN,
      },
      run,
    }));
    const boundary = new OperatorControlPlaneBoundary(
      {
        auth: { audience: OPERATOR_AUDIENCE, allowedPrincipals: [OPERATOR_PRINCIPAL] },
        demoRunSlot: "submission-demo-1",
        demoMandateId: "mandate-demo",
      },
      {
        tokenVerifier: fixedTokenVerifier(),
        executorProxy: fixture.proxy,
        actionGuard: new InMemoryOperatorActionGuard(),
        buildLiveFlow,
        now: () => "2026-08-03T01:00:02.000Z",
      },
    );
    const first = await boundary.runIncident(identity, makeRunEnvelope());
    expect(first.idempotentReplay).toBe(false);
    expect(first.result).toMatchObject({
      primary: { outcome: "denied", transactionCreated: false },
      denials: null,
    });
    const replay = await boundary.runIncident(identity, makeRunEnvelope());
    expect(replay).toMatchObject({
      idempotentReplay: true,
      result: {
        primary: { outcome: "denied", transactionCreated: false, txSignature: null },
        denials: null,
      },
    });
    expect(buildLiveFlow).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    const liveInput = run.mock.calls[0]![0];
    expect(liveInput.vendorAgentOrigin).toBe("https://vendor.uptime402.example");
    expect(liveInput.executorOrigin).toBe(EXECUTOR_ORIGIN);
  });

  it("automatically proves over-cap and nonce-replay denials after recovery in the same guarded action", async () => {
    const fixture = proxyFixture();
    const envelope = makeDualDenialEnvelope();
    const results = [recoveredResult(), deniedResult(), replayDeniedResult()];
    const run = vi.fn(async (_input: LiveIncidentRequest) => {
      const result = results.shift();
      if (!result) throw new Error("Unexpected extra live flow invocation");
      return result;
    });
    const createCapture = vi.fn(
      async (_input: OperatorIncidentCaptureInput) => undefined,
    );
    const boundary = new OperatorControlPlaneBoundary(
      {
        auth: { audience: OPERATOR_AUDIENCE, allowedPrincipals: [OPERATOR_PRINCIPAL] },
        demoRunSlot: "submission-demo-replay",
        demoMandateId: "mandate-demo",
      },
      {
        tokenVerifier: fixedTokenVerifier(),
        executorProxy: fixture.proxy,
        actionGuard: new InMemoryOperatorActionGuard(),
        incidentCaptureStore: { create: createCapture },
        buildLiveFlow: async () => ({
          config: {
            vendorAgentOrigin: "https://vendor.uptime402.example",
            executorOrigin: EXECUTOR_ORIGIN,
          },
          run,
        }),
        now: () => "2026-08-03T01:00:06.000Z",
      },
    );
    const result = await boundary.runIncident(identity, envelope);
    expect(result).toMatchObject({
      idempotentReplay: false,
      result: {
        primary: { outcome: "recovered", transactionCreated: true },
        denials: {
          overTransactionLimit: {
            outcome: "denied",
            reasonCode: "amount.per_transaction_limit",
            transactionCreated: false,
            txSignature: null,
          },
          replay: {
            outcome: "denied",
            reasonCode: "identifier.nonce_fresh",
            transactionCreated: false,
            txSignature: null,
          },
        },
        denialBindings: {
          overTransactionLimit: {
            denialType: "perTransactionLimit",
            attemptedAmountBaseUnits: "21000",
          },
          replay: {
            identifierType: "nonce",
            originalPaymentId: envelope.request.paymentId,
            deniedPaymentId: "payment-nonce-replay-denial",
            originalNonce: envelope.request.nonce,
            deniedNonce: envelope.request.nonce,
          },
        },
      },
    });
    expect(run).toHaveBeenCalledTimes(3);
    expect(createCapture).toHaveBeenCalledOnce();
    expect(createCapture.mock.calls[0]![0]).toMatchObject({
      runSlot: "submission-demo-replay",
      capturedAt: "2026-08-03T01:00:06.000Z",
      response: {
        idempotentReplay: false,
        result: {
          primary: { outcome: "recovered", transactionCreated: true },
          denials: {
            overTransactionLimit: { reasonCode: "amount.per_transaction_limit" },
            replay: { reasonCode: "identifier.nonce_fresh" },
          },
        },
      },
    });
    expect(run.mock.calls[1]![0]).toMatchObject({
      mandateId: envelope.request.mandateId,
      paymentId: "payment-over-cap-denial",
      incident: { id: "incident-over-cap-denial" },
      nonce: "payment-nonce-over-cap-denial",
      idempotencyKey: "idempotency-over-cap-denial",
    });
    expect(run.mock.calls[2]![0]).toMatchObject({
      mandateId: envelope.request.mandateId,
      paymentId: "payment-nonce-replay-denial",
      incident: { id: "incident-nonce-replay-denial" },
      nonce: envelope.request.nonce,
      idempotencyKey: "idempotency-nonce-replay-denial",
    });
    const replay = await boundary.runIncident(identity, envelope);
    expect(replay).toMatchObject({
      idempotentReplay: true,
      result: {
        primary: { outcome: "recovered", transactionCreated: true },
        denials: {
          overTransactionLimit: {
            outcome: "denied",
            reasonCode: "amount.per_transaction_limit",
            transactionCreated: false,
            txSignature: null,
          },
          replay: {
            outcome: "denied",
            reasonCode: "identifier.nonce_fresh",
            transactionCreated: false,
            txSignature: null,
          },
        },
      },
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("rejects a dual-denial request that does not reuse the primary nonce", () => {
    const envelope = makeDualDenialEnvelope();
    expect(() =>
      OperatorRunIncidentRequestSchema.parse({
        ...envelope,
        denialRequests: {
          ...envelope.denialRequests,
          replay: {
            ...envelope.denialRequests.replay,
            nonce: "fresh-nonce-does-not-prove-replay",
          },
        },
      }),
    ).toThrow();
  });

  it("blocks a different request in the same server-configured demo slot", async () => {
    const fixture = proxyFixture();
    const boundary = new OperatorControlPlaneBoundary(
      {
        auth: { audience: OPERATOR_AUDIENCE, allowedPrincipals: [OPERATOR_PRINCIPAL] },
        demoRunSlot: "submission-demo-2",
        demoMandateId: "mandate-demo",
      },
      {
        tokenVerifier: fixedTokenVerifier(),
        executorProxy: fixture.proxy,
        actionGuard: new InMemoryOperatorActionGuard(),
        buildLiveFlow: async () => ({
          config: {
            vendorAgentOrigin: "https://vendor.uptime402.example",
            executorOrigin: EXECUTOR_ORIGIN,
          },
          run: async () => deniedResult(),
        }),
        now: () => "2026-08-03T01:00:02.000Z",
      },
    );
    await boundary.runIncident(identity, makeRunEnvelope());
    await expect(
      boundary.runIncident(identity, makeRunEnvelope("different-idempotency")),
    ).rejects.toMatchObject({
      status: 409,
      code: "operator_action_conflict",
    });
  });

  it("locks failure without an automatic retry and rejects signer/origin fields", async () => {
    const fixture = proxyFixture();
    const buildLiveFlow = vi.fn(async () => {
      throw new Error("fixture failure after claim");
    });
    const boundary = new OperatorControlPlaneBoundary(
      {
        auth: { audience: OPERATOR_AUDIENCE, allowedPrincipals: [OPERATOR_PRINCIPAL] },
        demoRunSlot: "submission-demo-3",
        demoMandateId: "mandate-demo",
      },
      {
        tokenVerifier: fixedTokenVerifier(),
        executorProxy: fixture.proxy,
        actionGuard: new InMemoryOperatorActionGuard(),
        buildLiveFlow,
        now: () => "2026-08-03T01:00:02.000Z",
      },
    );
    await expect(
      boundary.runIncident(identity, {
        ...makeRunEnvelope(),
        executorWalletPrivateKey: "forbidden",
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_operator_request" });
    await expect(
      boundary.runIncident(identity, makeRunEnvelope()),
    ).rejects.toMatchObject({ status: 502, code: "incident_run_failed_locked" });
    await expect(
      boundary.runIncident(identity, makeRunEnvelope()),
    ).rejects.toMatchObject({ status: 409, code: "operator_action_failed_locked" });
    expect(buildLiveFlow).toHaveBeenCalledOnce();
  });
});

describe("operator HTTP and mandate CLI safety helpers", () => {
  it("auth route JSON reader rejects duplicate keys and unsupported content type", async () => {
    await expect(
      readStrictOperatorJson(
        new Request("https://control.example/api/operator", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"schemaVersion":"1","schemaVersion":"2"}',
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "operator_request_json_invalid",
    });
    await expect(
      readStrictOperatorJson(
        new Request("https://control.example/api/operator", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 415, code: "operator_json_required" });
  });

  it("rejects duplicate keys in standalone mandate input", () => {
    expect(() => parseMandateJson('{"id":"one","id":"two"}')).toThrow(
      /Duplicate JSON key/,
    );
  });

  it("signs a mandate with an existing injected key and never creates a key", async () => {
    const signer = await generateKeyPairSigner();
    const unsigned = MandateUnsignedSchema.parse(
      omitKeys(makeMandate(), ["mandateHash", "attestation"] as const),
    );
    const signed = await buildSignedMandate(unsigned, {
      signer,
      keyId: "mandate-v1",
    });
    expect(signed.mandateHash).toBe(computeMandateHash(unsigned));
    await expect(
      verifyCanonicalEd25519Signature({
        payload: unsigned,
        payloadSchema: MandateUnsignedSchema,
        signerPublicKey: signer.address,
        signature: signed.attestation.signature,
      }),
    ).resolves.toBe(true);
  });

  it("production config requires a real Firestore boundary and server demo slot", () => {
    expect(() =>
      parseProductionOperatorBoundaryRuntimeConfig({
        NODE_ENV: "test",
        FIRESTORE_PROJECT_ID: "uptime402",
        FIRESTORE_COLLECTION_PREFIX: "uptime402",
        PAYMENT_EXECUTOR_ORIGIN: EXECUTOR_ORIGIN,
        CONTROL_PLANE_DEMO_RUN_SLOT: "submission-demo",
        CONTROL_PLANE_DEMO_MANDATE_ID: "mandate-demo",
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      }),
    ).toThrow(/refuses FIRESTORE_EMULATOR_HOST/);
    expect(
      parseProductionOperatorBoundaryRuntimeConfig({
        NODE_ENV: "test",
        FIRESTORE_PROJECT_ID: "uptime402",
        FIRESTORE_COLLECTION_PREFIX: "uptime402",
        PAYMENT_EXECUTOR_ORIGIN: EXECUTOR_ORIGIN,
        CONTROL_PLANE_DEMO_RUN_SLOT: "submission-demo",
        CONTROL_PLANE_DEMO_MANDATE_ID: "mandate-demo",
      }),
    ).toMatchObject({
      demoRunSlot: "submission-demo",
      demoMandateId: "mandate-demo",
      executorOrigin: EXECUTOR_ORIGIN,
    });
  });

  it("keeps every operator mutation route disabled unless explicitly enabled", () => {
    expect(() => requireOperatorMutationsEnabled({})).toThrow(
      "operator_mutations_disabled",
    );
    expect(() =>
      requireOperatorMutationsEnabled({ CONTROL_PLANE_MUTATIONS_ENABLED: "false" }),
    ).toThrow("operator_mutations_disabled");
    expect(() =>
      requireOperatorMutationsEnabled({ CONTROL_PLANE_MUTATIONS_ENABLED: "invalid" }),
    ).toThrow("operator_mutations_disabled");
    expect(() =>
      requireOperatorMutationsEnabled({ CONTROL_PLANE_MUTATIONS_ENABLED: "true" }),
    ).not.toThrow();
  });
});
