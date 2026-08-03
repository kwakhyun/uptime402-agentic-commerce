import type { Server } from "node:http";

import {
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
} from "@uptime402/domain";
import { RuntimeOperationRecordSchema } from "@uptime402/persistence";
import express from "express";
import { describe, expect, it, vi } from "vitest";

import {
  parsePaymentExecutorRuntimeConfig,
  startPaymentExecutor,
} from "../services/payment-executor/src/runtime.js";
import {
  parseVendorAgentRuntimeConfig,
  startVendorAgent,
  verifyFacilitatorExactSvmSupport,
} from "../services/vendor-agent/src/runtime.js";

const KEY_A = "11111111111111111111111111111111";
const KEY_B = "SysvarRent111111111111111111111111111111111";
const KEY_C = "Vote111111111111111111111111111111111111111";
const FEE_PAYER = "ComputeBudget111111111111111111111111111111";

function devnetEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PORT: "8080",
    SOLANA_CLUSTER_LABEL: "devnet",
    SOLANA_GENESIS_HASH: DEVNET_GENESIS_HASH,
    X402_NETWORK_ID: DEVNET_X402_NETWORK_ID,
    X402_SDK_NETWORK_ID: DEVNET_X402_NETWORK_ID,
    USDC_MINT: DEVNET_USDC_MINT,
    USDC_DECIMALS: "6",
    FIRESTORE_PROJECT_ID: "uptime402-devnet",
    FIRESTORE_COLLECTION_PREFIX: "uptime402",
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    X402_FACILITATOR_URL: "https://x402.org/facilitator",
  };
}

function executorEnvironment(): NodeJS.ProcessEnv {
  return {
    ...devnetEnvironment(),
    EXECUTOR_EXPECTED_AUDIENCE: "https://executor.example",
    CONTROL_PLANE_SERVICE_ACCOUNT: "control@example.iam.gserviceaccount.com",
    OPERATOR_PRINCIPAL: "operator@example.iam.gserviceaccount.com",
    MANDATE_ISSUER_PRINCIPAL: "operator:uptime402",
    MANDATE_SIGNER_PUBLIC_KEY: KEY_A,
    MANDATE_SIGNER_KEY_ID: "mandate-v1",
    VENDOR_OFFER_SIGNER_PUBLIC_KEY: KEY_B,
    VENDOR_OFFER_SIGNER_KEY_ID: "offer-v1",
    EXECUTOR_WALLET_KEYPAIR_PATH: "/var/run/secrets/executor.json",
    EXECUTOR_WALLET_SECRET_ROOT: "/var/run/secrets",
    EXECUTOR_WALLET_PUBLIC_KEY: KEY_C,
    ALLOWED_VENDOR_ORIGINS: "https://vendor.example",
    ESTIMATED_NETWORK_FEE_LAMPORTS: "10000",
  };
}

function vendorEnvironment(): NodeJS.ProcessEnv {
  return {
    ...devnetEnvironment(),
    PUBLIC_VENDOR_ORIGIN: "https://vendor.example",
    VENDOR_AGENT_ID: "vendor-agent-1",
    VENDOR_AGENT_NAME: "Uptime402 Recovery Vendor",
    VENDOR_TENANT: "vendor-tenant-1",
    VENDOR_OFFER_CATALOG_PATH: "/etc/uptime402/offers.json",
    VENDOR_OFFER_CATALOG_ROOT: "/etc/uptime402",
    VENDOR_OFFER_SIGNER_PUBLIC_KEY: KEY_A,
    VENDOR_OFFER_SIGNER_KEY_ID: "offer-v1",
    VENDOR_RECEIPT_KEY_PATH: "/var/run/secrets/vendor-receipt.json",
    VENDOR_RECEIPT_SECRET_ROOT: "/var/run/secrets",
    VENDOR_RECEIPT_PUBLIC_KEY: KEY_A,
    VENDOR_RECEIPT_KEY_ID: "offer-v1",
    VENDOR_USDC_RECIPIENT: KEY_C,
    VENDOR_EXPECTED_PAYER_PUBLIC_KEY: KEY_B,
    VENDOR_RECONCILE_EXPECTED_AUDIENCE: "https://vendor.example",
    VENDOR_RECONCILE_CONTROL_PLANE_PRINCIPAL:
      "control@uptime402-devnet.iam.gserviceaccount.com",
    X402_FACILITATOR_FEE_PAYER: FEE_PAYER,
    X402_MAX_TIMEOUT_SECONDS: "120",
  };
}

describe("production service runtime configuration", () => {
  it("shares a strict immutable operation handoff contract with the control plane", () => {
    const operation = {
      id: "operation-1",
      requiredCapability: "failover-routing",
      subject: "service:primary-api",
      request: {
        method: "POST" as const,
        resourceUrl: "https://vendor.example/v1/recovery",
        operationId: "operation-1",
        canonicalBodyHash: `sha256:${"a".repeat(64)}`,
      },
    };
    expect(RuntimeOperationRecordSchema.parse(operation)).toEqual(operation);
    expect(() =>
      RuntimeOperationRecordSchema.parse({
        ...operation,
        request: { ...operation.request, operationId: "operation-other" },
      }),
    ).toThrow(/must match/);
  });

  it("fails closed with a clear missing-variable error and rejects mainnet labels", () => {
    const missing = executorEnvironment();
    delete missing.EXECUTOR_WALLET_KEYPAIR_PATH;
    expect(() => parsePaymentExecutorRuntimeConfig(missing)).toThrow(
      "Missing required environment variable: EXECUTOR_WALLET_KEYPAIR_PATH",
    );

    const mainnet = vendorEnvironment();
    mainnet.SOLANA_CLUSTER_LABEL = "mainnet-beta";
    expect(() => parseVendorAgentRuntimeConfig(mainnet)).toThrow(
      "SOLANA_CLUSTER_LABEL must equal the pinned Devnet value",
    );

    const missingCatalogRoot = vendorEnvironment();
    delete missingCatalogRoot.VENDOR_OFFER_CATALOG_ROOT;
    expect(() => parseVendorAgentRuntimeConfig(missingCatalogRoot)).toThrow(
      "Missing required environment variable: VENDOR_OFFER_CATALOG_ROOT",
    );
  });

  it("parses Cloud Run PORT/HOST without exposing or loading signer files", () => {
    const executor = parsePaymentExecutorRuntimeConfig({
      ...executorEnvironment(),
      PORT: "9090",
      HOST: "127.0.0.2",
    });
    expect(executor).toMatchObject({ port: 9090, host: "127.0.0.2" });
    const vendor = parseVendorAgentRuntimeConfig(vendorEnvironment());
    expect(vendor).toMatchObject({
      port: 8080,
      host: "0.0.0.0",
      expectedPayerPublicKey: KEY_B,
    });
  });

  it("requires one pinned vendor authority for both offers and receipts", () => {
    const mismatched = vendorEnvironment();
    mismatched.VENDOR_RECEIPT_KEY_ID = "receipt-v2";
    expect(() => parseVendorAgentRuntimeConfig(mismatched)).toThrow(
      "same pinned vendor Agent Card authority",
    );
  });

  it("starts each built Express app on the injected Cloud Run address", async () => {
    const server = {} as Server;
    const executorBuild = vi.fn(async () => express());
    const executorListen = vi.fn(async () => server);
    await expect(
      startPaymentExecutor({
        env: executorEnvironment(),
        buildApp: executorBuild,
        listen: executorListen,
      }),
    ).resolves.toBe(server);
    expect(executorBuild).toHaveBeenCalledOnce();
    expect(executorListen).toHaveBeenCalledWith(expect.any(Function), 8080, "0.0.0.0");

    const vendorBuild = vi.fn(async () => express());
    const vendorListen = vi.fn(async () => server);
    await expect(
      startVendorAgent({
        env: vendorEnvironment(),
        buildApp: vendorBuild,
        listen: vendorListen,
      }),
    ).resolves.toBe(server);
    expect(vendorBuild).toHaveBeenCalledOnce();
    expect(vendorListen).toHaveBeenCalledWith(expect.any(Function), 8080, "0.0.0.0");
  });
});

describe("official exact SVM facilitator requirement enhancement", () => {
  it("accepts only a pinned fee payer advertised by the exact Devnet kind", async () => {
    const supported = {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: DEVNET_X402_NETWORK_ID,
          extra: { feePayer: FEE_PAYER },
        },
      ],
      extensions: [],
      signers: { [DEVNET_X402_NETWORK_ID]: [FEE_PAYER] },
    };
    await expect(verifyFacilitatorExactSvmSupport(supported, FEE_PAYER)).resolves.toBe(FEE_PAYER);
    await expect(verifyFacilitatorExactSvmSupport(supported, KEY_A)).rejects.toThrow(
      /not advertised/,
    );
    await expect(
      verifyFacilitatorExactSvmSupport(
        {
          ...supported,
          kinds: [{ ...supported.kinds[0]!, extra: {} }],
        },
        FEE_PAYER,
      ),
    ).rejects.toThrow(/missing or mismatched/);
  });

  it("accepts the official Solana namespace signer fallback without overriding an exact set", async () => {
    const supported = {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: DEVNET_X402_NETWORK_ID,
          extra: { feePayer: FEE_PAYER },
        },
      ],
      extensions: [],
      signers: { "solana:*": [FEE_PAYER] },
    };
    await expect(verifyFacilitatorExactSvmSupport(supported, FEE_PAYER)).resolves.toBe(FEE_PAYER);
    await expect(
      verifyFacilitatorExactSvmSupport(
        {
          ...supported,
          signers: {
            ...supported.signers,
            [DEVNET_X402_NETWORK_ID]: [KEY_A],
          },
        },
        FEE_PAYER,
      ),
    ).rejects.toThrow(/not advertised/);
  });
});
