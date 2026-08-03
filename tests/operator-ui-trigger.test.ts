import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  computeExecutionPolicyHash,
  createNetworkIdentity,
} from "@uptime402/domain";
import { describe, expect, it } from "vitest";

import { parseLiveOperatorUiResponse } from "../apps/control-plane/src/live-ui-contract.js";
import type { OperatorIncidentMutationResult } from "../apps/control-plane/src/server/operator-boundary.js";
import {
  assertSameOriginBodylessLiveRequest,
  hashServerOwnedIncidentRunBinding,
  parseLiveOperatorUiConfig,
  projectLiveOperatorUiResponse,
  readServerOwnedIncidentRequest,
  requireLiveOperatorUiConfig,
} from "../apps/control-plane/src/server/operator-ui-trigger.js";

const CLIENT_ID = "123456789-uptime402.apps.googleusercontent.com";
const CONTROL_ORIGIN = "https://control.uptime402.example";
const KEY_A = "11111111111111111111111111111111";

function configuredEnvironment(path: string, root: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    CONTROL_PLANE_UI_LIVE_TRIGGER_ENABLED: "true",
    CONTROL_PLANE_UI_GOOGLE_CLIENT_ID: CLIENT_ID,
    CONTROL_PLANE_OPERATOR_AUDIENCE: CLIENT_ID,
    CONTROL_PLANE_ORIGIN: CONTROL_ORIGIN,
    CONTROL_PLANE_UI_LIVE_REQUEST_PATH: path,
    CONTROL_PLANE_UI_LIVE_REQUEST_ROOT: root,
  };
}

function requestFixture() {
  const unsignedPolicy = {
    id: "policy-live-ui",
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
  const request = {
    incident: {
      id: "incident-live-ui",
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
    mandateId: "mandate-live-ui",
    subject: "service:checkout",
    operationId: "operation-live-ui",
    paymentId: "payment-live-ui",
    nonce: "nonce-live-ui",
    idempotencyKey: "idempotency-live-ui",
    executionPolicy: {
      ...unsignedPolicy,
      policyHash: computeExecutionPolicyHash(unsignedPolicy),
    },
  };
  return {
    schemaVersion: "1" as const,
    request,
    denialRequests: {
      expectedPerTransactionLimitBaseUnits: "20000" as const,
      overTransactionLimit: {
        ...request,
        incident: {
          ...request.incident,
          id: "incident-live-ui-over-cap",
          observedAt: "2026-08-03T01:00:04.000Z",
          rawTelemetry: {
            ...request.incident.rawTelemetry,
            latencyMs: 100,
            failureRate: 0.2,
          },
        },
        operationId: "operation-live-ui-over-cap",
        paymentId: "payment-live-ui-over-cap",
        nonce: "nonce-live-ui-over-cap",
        idempotencyKey: "idempotency-live-ui-over-cap",
      },
      replay: {
        ...request,
        incident: {
          ...request.incident,
          id: "incident-live-ui-replay",
          observedAt: "2026-08-03T01:00:05.000Z",
        },
        operationId: "operation-live-ui-replay",
        paymentId: "payment-live-ui-replay",
        idempotencyKey: "idempotency-live-ui-replay",
      },
    },
  };
}

function event(sequence = 1) {
  return {
    sequence,
    correlationId: "correlation-live-ui",
    kind: "settlement_confirmed",
    occurredAt: "2026-08-03T01:00:04.000Z",
    protocolLabel: "x402 settle",
    evidenceLevel: "live-unverified",
    transactionCreated: true,
    txSignature: "2".repeat(88),
    details: {
      explorerUrl: "https://explorer.solana.com/tx/forbidden",
      tokenDeltas: ["must-not-cross-ui-boundary"],
    },
  } as const;
}

describe("dormant secure live UI trigger", () => {
  it("stays disabled unless explicitly enabled and pins GIS client ID to the server audience", () => {
    expect(parseLiveOperatorUiConfig({ NODE_ENV: "test" })).toEqual({ mode: "disabled" });
    expect(
      parseLiveOperatorUiConfig(configuredEnvironment("/config/request.json", "/config")),
    ).toEqual({
      mode: "google-oidc-live",
      clientId: CLIENT_ID,
      audience: CLIENT_ID,
    });

    const mismatch = configuredEnvironment("/config/request.json", "/config");
    mismatch.CONTROL_PLANE_OPERATOR_AUDIENCE = "987654-other.apps.googleusercontent.com";
    expect(() => parseLiveOperatorUiConfig(mismatch)).toThrow(/exactly equal/u);
    expect(() => requireLiveOperatorUiConfig({ NODE_ENV: "test" })).toThrow(/disabled/u);
  });

  it("accepts a version-indirected in-root read-only request and rejects duplicate keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "uptime402-live-ui-"));
    const versionDirectory = join(root, "7");
    await mkdir(versionDirectory);
    const target = join(versionDirectory, "request.json");
    await writeFile(target, JSON.stringify(requestFixture()), { mode: 0o600 });
    const mountedPath = join(root, "request.json");
    await symlink("7/request.json", mountedPath);

    const parsed = await readServerOwnedIncidentRequest({
      requestPath: mountedPath,
      requestRoot: root,
    });
    expect(parsed.request.mandateId).toBe("mandate-live-ui");
    expect(hashServerOwnedIncidentRunBinding(parsed)).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const duplicatePath = join(root, "duplicate.json");
    await writeFile(
      duplicatePath,
      JSON.stringify(requestFixture()).replace(
        '"schemaVersion":"1"',
        '"schemaVersion":"1","schemaVersion":"1"',
      ),
      { mode: 0o600 },
    );
    await expect(
      readServerOwnedIncidentRequest({ requestPath: duplicatePath, requestRoot: root }),
    ).rejects.toThrow(/Duplicate JSON key/u);
  });

  it("rejects path escape, writable config, and oversized config", async () => {
    const root = await mkdtemp(join(tmpdir(), "uptime402-live-ui-root-"));
    const outside = await mkdtemp(join(tmpdir(), "uptime402-live-ui-outside-"));
    const outsidePath = join(outside, "request.json");
    await writeFile(outsidePath, JSON.stringify(requestFixture()), { mode: 0o600 });
    const escapePath = join(root, "escape.json");
    await symlink(outsidePath, escapePath);
    await expect(
      readServerOwnedIncidentRequest({ requestPath: escapePath, requestRoot: root }),
    ).rejects.toThrow(/outside/u);

    const writable = join(root, "writable.json");
    await writeFile(writable, JSON.stringify(requestFixture()), { mode: 0o600 });
    await chmod(writable, 0o622);
    await expect(
      readServerOwnedIncidentRequest({ requestPath: writable, requestRoot: root }),
    ).rejects.toThrow(/owner-readable/u);

    const oversized = join(root, "oversized.json");
    await writeFile(oversized, "x".repeat(512 * 1024 + 1), { mode: 0o600 });
    await expect(
      readServerOwnedIncidentRequest({ requestPath: oversized, requestRoot: root }),
    ).rejects.toThrow(/bounded/u);
  });

  it("requires exact same-origin, bodyless browser POST semantics", () => {
    expect(() =>
      assertSameOriginBodylessLiveRequest(
        new Request(`${CONTROL_ORIGIN}/api/operator/incidents/demo-run`, {
          method: "POST",
          headers: { origin: CONTROL_ORIGIN, "sec-fetch-site": "same-origin" },
        }),
        CONTROL_ORIGIN,
      ),
    ).not.toThrow();

    // Google Frontend can remove Fetch Metadata before the request reaches
    // the Cloud Run container. Exact URL + exact Referer + non-ambient bearer
    // authentication remains the accepted bodyless same-origin fallback.
    expect(() =>
      assertSameOriginBodylessLiveRequest(
        new Request(`${CONTROL_ORIGIN}/api/operator/incidents/demo-run`, {
          method: "POST",
          headers: { referer: `${CONTROL_ORIGIN}/` },
        }),
        CONTROL_ORIGIN,
      ),
    ).not.toThrow();

    expect(() =>
      assertSameOriginBodylessLiveRequest(
        new Request(`${CONTROL_ORIGIN}/api/operator/incidents/demo-run`, {
          method: "POST",
          headers: {
            referer: `${CONTROL_ORIGIN}/`,
            "sec-fetch-site": "cross-site",
          },
        }),
        CONTROL_ORIGIN,
      ),
    ).toThrow(/origin_forbidden/u);

    // Cloud Run can reconstruct Request.url with its internal listener and can
    // surface an opaque Origin while preserving the browser-controlled public
    // Referer. The non-ambient Google bearer token is verified separately.
    expect(() =>
      assertSameOriginBodylessLiveRequest(
        new Request("http://0.0.0.0:8080/api/operator/incidents/demo-run", {
          method: "POST",
          headers: {
            origin: "null",
            referer: `${CONTROL_ORIGIN}/`,
            "sec-fetch-site": "same-site",
          },
        }),
        CONTROL_ORIGIN,
      ),
    ).not.toThrow();

    expect(() =>
      assertSameOriginBodylessLiveRequest(
        new Request("http://0.0.0.0:8080/api/operator/incidents/demo-run", {
          method: "POST",
          headers: { referer: "https://attacker.example/" },
        }),
        CONTROL_ORIGIN,
      ),
    ).toThrow(/origin_forbidden/u);

    expect(() =>
      assertSameOriginBodylessLiveRequest(
        new Request(`${CONTROL_ORIGIN}/api/operator/incidents/demo-run`, {
          method: "POST",
          headers: {
            referer: `${CONTROL_ORIGIN}/`,
            "sec-fetch-site": "same-origin",
          },
        }),
        CONTROL_ORIGIN,
      ),
    ).not.toThrow();

    expect(() =>
      assertSameOriginBodylessLiveRequest(
        new Request(`${CONTROL_ORIGIN}/api/operator/incidents/demo-run`, {
          method: "POST",
          headers: { "sec-fetch-site": "same-origin" },
        }),
        CONTROL_ORIGIN,
      ),
    ).toThrow(/origin_forbidden/u);

    expect(() =>
      assertSameOriginBodylessLiveRequest(
        new Request(`${CONTROL_ORIGIN}/api/operator/incidents/demo-run`, {
          method: "POST",
          headers: { origin: "https://attacker.example" },
        }),
        CONTROL_ORIGIN,
      ),
    ).toThrow(/origin_forbidden/u);

    expect(() =>
      assertSameOriginBodylessLiveRequest(
        new Request(`${CONTROL_ORIGIN}/api/operator/incidents/demo-run`, {
          method: "POST",
          headers: { origin: CONTROL_ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ executionPolicy: "browser-controlled" }),
        }),
        CONTROL_ORIGIN,
      ),
    ).toThrow(/body_forbidden/u);

    expect(() =>
      assertSameOriginBodylessLiveRequest(
        new Request(`${CONTROL_ORIGIN}/api/operator/incidents/demo-run`, {
          method: "POST",
          headers: {
            origin: CONTROL_ORIGIN,
            "content-length": "8",
          },
        }),
        CONTROL_ORIGIN,
      ),
    ).toThrow(/body_forbidden/u);
  });

  it("projects response events as LIVE UNVERIFIED without public chain-proof claims", () => {
    const mutation = {
      schemaVersion: "1",
      separation: "application-role",
      idempotentReplay: false,
      result: {
        primary: {
          outcome: "recovered",
          transactionCreated: true,
          txSignature: "2".repeat(88),
          evidence: {
            level: "live-unverified",
            explorerUrl: null,
            tokenDeltas: [],
          },
          events: [event()],
        },
        denials: {
          overTransactionLimit: {
            outcome: "denied",
            reasonCode: "amount.per_transaction_limit",
            transactionCreated: false,
            txSignature: null,
            evidence: {
              level: "live-unverified",
              explorerUrl: null,
              tokenDeltas: [],
            },
            events: [
              {
                ...event(1),
                correlationId: "correlation-over-cap",
                kind: "policy_denied",
                transactionCreated: false,
                txSignature: null,
              },
            ],
          },
          replay: {
            outcome: "denied",
            reasonCode: "identifier.nonce_fresh",
            transactionCreated: false,
            txSignature: null,
            evidence: {
              level: "live-unverified",
              explorerUrl: null,
              tokenDeltas: [],
            },
            events: [
              {
                ...event(1),
                correlationId: "correlation-replay",
                kind: "policy_denied",
                transactionCreated: false,
                txSignature: null,
              },
            ],
          },
        },
        denialBindings: null,
        denialBindingHashes: null,
      },
    } as unknown as OperatorIncidentMutationResult;
    const result = projectLiveOperatorUiResponse(
      mutation,
      `sha256:${"a".repeat(64)}`,
    );
    expect(parseLiveOperatorUiResponse(result)).toEqual(result);
    expect(result).toMatchObject({
      evidenceLevel: "live-unverified",
      primary: { outcome: "recovered", transactionCreated: true },
      denials: {
        overTransactionLimit: {
          reasonCode: "amount.per_transaction_limit",
          transactionCreated: false,
        },
        replay: {
          reasonCode: "identifier.nonce_fresh",
          transactionCreated: false,
        },
      },
      events: [
        { kind: "settlement_confirmed", phase: "primary" },
        { kind: "policy_denied", phase: "overTransactionLimit" },
        { kind: "policy_denied", phase: "replay" },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("explorer.solana.com");
    expect(serialized).not.toContain("tokenDeltas");
    expect(serialized).not.toContain("txSignature");
    expect(serialized).not.toContain("devnet-verified");
  });

  it("keeps the ID token out of browser persistence and submits no policy body", async () => {
    const source = await readFile(
      new URL("../apps/control-plane/components/live-operator-trigger.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|console\./u);
    expect(source).toContain('fetch("/api/operator/incidents/demo-run"');
    expect(source).not.toMatch(/body\s*:/u);
    expect(source).toContain('credentials: "same-origin"');
  });
});
