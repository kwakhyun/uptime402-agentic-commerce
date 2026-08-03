import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  VendorOfferPayloadSchema,
  canonicalHash,
} from "@uptime402/domain";
import { verifyCanonicalEd25519Signature } from "@uptime402/payments";
import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";

import {
  signVendorOfferCatalog,
  type VendorOfferCatalogSigningInput,
} from "../services/vendor-agent/src/catalog-signing.js";
import { buildVendorAgentCard } from "../services/vendor-agent/src/index.js";
import {
  loadAndVerifyOfferCatalog,
  type VendorAgentRuntimeConfig,
} from "../services/vendor-agent/src/runtime.js";

const ORIGIN = "https://vendor.uptime402.example";
const KEY_ID = "did:web:vendor.uptime402.example#vendor-v1";

function input(payee: string): VendorOfferCatalogSigningInput {
  const common = {
    providerAgentId: "vendor-agent-1",
    providerAgentCardUrl: `${ORIGIN}/.well-known/agent-card.json`,
    resourceUrl: `${ORIGIN}/v1/recovery`,
    network: DEVNET_X402_NETWORK_ID,
    asset: "USDC" as const,
    assetMint: DEVNET_USDC_MINT,
    payee,
    expiresAt: "2099-01-01T00:00:00.000Z",
    capability: "solana-rpc-health",
    method: "POST" as const,
  };
  return {
    schemaVersion: "1",
    agent: {
      agentId: "vendor-agent-1",
      agentName: "Uptime402 recovery vendor",
      agentDescription: "Owned vendor for paid incident recovery resources.",
      agentOrigin: ORIGIN,
      vendorTenant: "vendor-tenant-1",
    },
    offers: [
      { ...common, offerId: "rpc-fast", amountBaseUnits: "18000" },
      { ...common, offerId: "rpc-economy", amountBaseUnits: "9000" },
    ],
    offerEvaluations: [
      { offerId: "rpc-fast", latencyMs: 70, description: "Fast route" },
      { offerId: "rpc-economy", latencyMs: 420, description: "Economy route" },
    ],
  };
}

function runtimeConfig(
  offerCatalogPath: string,
  offerCatalogRoot: string,
  offerSignerPublicKey: string,
  usdcRecipient: string,
): VendorAgentRuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 4100,
    firestoreProjectId: "fixture",
    firestoreDatabaseId: "(default)",
    firestoreCollectionPrefix: "fixture",
    agentId: "vendor-agent-1",
    agentName: "Uptime402 recovery vendor",
    agentDescription: "Owned vendor for paid incident recovery resources.",
    agentOrigin: ORIGIN,
    vendorTenant: "vendor-tenant-1",
    offerCatalogPath,
    offerCatalogRoot,
    offerSignerPublicKey,
    offerSignerKeyId: KEY_ID,
    receiptKeyPath: "/unused/vendor.json",
    receiptSecretRoot: "/unused",
    receiptPublicKey: offerSignerPublicKey,
    receiptKeyId: KEY_ID,
    usdcRecipient,
    expectedPayerPublicKey: "ComputeBudget111111111111111111111111111111",
    reconciliationAudience: ORIGIN,
    allowedReconciliationPrincipal:
      "control@uptime402-devnet.iam.gserviceaccount.com",
    solanaRpcUrl: "https://api.devnet.solana.com/",
    facilitatorUrl: "https://facilitator.example/",
    facilitatorOrigin: "https://facilitator.example",
    facilitatorFeePayer: usdcRecipient,
    maxTimeoutSeconds: 60,
    settlementConfirmationAttempts: 1,
    settlementConfirmationDelayMs: 50,
  };
}

async function signedCatalogFixture() {
  const [signer, payee] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const catalog = await signVendorOfferCatalog({
    input: input(payee.address),
    signer,
    expectedSignerPublicKey: signer.address,
    keyId: KEY_ID,
  });
  return { catalog, signer, payee };
}

describe("normative vendor offer catalog signing", () => {
  it("signs the exact payment-evidence-v2 payload and binds the raw Agent Card hash", async () => {
    const [signer, payee] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const catalog = await signVendorOfferCatalog({
      input: input(payee.address),
      signer,
      expectedSignerPublicKey: signer.address,
      keyId: KEY_ID,
    });
    const rawAgentCard = buildVendorAgentCard(
      {
        ...input(payee.address).agent,
        a2aPath: "/a2a",
      },
      { signerPublicKey: signer.address, keyId: KEY_ID },
    );

    expect(catalog.schemaVersion).toBe("2");
    expect(Object.keys(catalog.offers[0]).sort()).toEqual([
      "keyId",
      "payload",
      "signature",
      "signer",
    ]);
    expect(catalog.offers.every((offer) =>
      offer.payload.providerAgentCardHash === canonicalHash(rawAgentCard)
    )).toBe(true);
    for (const offer of catalog.offers) {
      await expect(verifyCanonicalEd25519Signature({
        payload: offer.payload,
        payloadSchema: VendorOfferPayloadSchema,
        signerPublicKey: offer.signer,
        signature: offer.signature,
      })).resolves.toBe(true);
      const mutation = { ...offer.payload, amountBaseUnits: "1" };
      await expect(verifyCanonicalEd25519Signature({
        payload: mutation,
        payloadSchema: VendorOfferPayloadSchema,
        signerPublicKey: offer.signer,
        signature: offer.signature,
      })).resolves.toBe(false);
    }
  });

  it("refuses a payee that is also the Agent Card signing authority", async () => {
    const signer = await generateKeyPairSigner();
    await expect(signVendorOfferCatalog({
      input: input(signer.address),
      signer,
      expectedSignerPublicKey: signer.address,
      keyId: KEY_ID,
    })).rejects.toThrow(/differ from the USDC payee/u);
  });

  it("loads the same normative envelopes in the production vendor catalog path", async () => {
    const { catalog, signer, payee } = await signedCatalogFixture();
    const directory = await mkdtemp(join(tmpdir(), "uptime402-offers-"));
    const catalogPath = join(await realpath(directory), "offers.json");
    try {
      await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
      const config = runtimeConfig(catalogPath, directory, signer.address, payee.address);
      const loaded = await loadAndVerifyOfferCatalog(config);
      expect(loaded.offers).toEqual(catalog.offers);
      expect(loaded.offerEvaluations).toEqual(catalog.offerEvaluations);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("loads the in-root symlink chain used by Cloud Run Secret Manager volumes", async () => {
    const { catalog, signer, payee } = await signedCatalogFixture();
    const directory = await realpath(await mkdtemp(join(tmpdir(), "uptime402-secret-volume-")));
    try {
      const versionDirectory = join(directory, "..2026_08_03_000001");
      await mkdir(versionDirectory);
      await writeFile(join(versionDirectory, "offers.json"), JSON.stringify(catalog), {
        mode: 0o444,
      });
      await symlink("..2026_08_03_000001", join(directory, "..data"));
      const mountedCatalogPath = join(directory, "offers.json");
      await symlink("..data/offers.json", mountedCatalogPath);

      const loaded = await loadAndVerifyOfferCatalog(
        runtimeConfig(mountedCatalogPath, directory, signer.address, payee.address),
      );
      expect(loaded.offers).toEqual(catalog.offers);
      expect(loaded.offerEvaluations).toEqual(catalog.offerEvaluations);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("rejects catalog links that escape the root, non-regular targets, and oversized files", async () => {
    const { catalog, signer, payee } = await signedCatalogFixture();
    const directory = await realpath(await mkdtemp(join(tmpdir(), "uptime402-offer-root-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "uptime402-offer-outside-")));
    try {
      const outsideCatalog = join(outside, "offers.json");
      await writeFile(outsideCatalog, JSON.stringify(catalog), { mode: 0o600 });
      await expect(
        loadAndVerifyOfferCatalog(
          runtimeConfig(outsideCatalog, directory, signer.address, payee.address),
        ),
      ).rejects.toThrow(/path is outside the configured catalog root/u);

      const escaped = join(directory, "escaped.json");
      await symlink(outsideCatalog, escaped);
      await expect(
        loadAndVerifyOfferCatalog(
          runtimeConfig(escaped, directory, signer.address, payee.address),
        ),
      ).rejects.toThrow(/resolves outside the configured catalog root/u);

      const catalogDirectory = join(directory, "catalog-directory");
      await mkdir(catalogDirectory);
      await expect(
        loadAndVerifyOfferCatalog(
          runtimeConfig(catalogDirectory, directory, signer.address, payee.address),
        ),
      ).rejects.toThrow(/non-empty regular file/u);

      const oversized = join(directory, "oversized.json");
      await writeFile(oversized, Buffer.alloc(256 * 1024 + 1, 0x20), { mode: 0o600 });
      await expect(
        loadAndVerifyOfferCatalog(
          runtimeConfig(oversized, directory, signer.address, payee.address),
        ),
      ).rejects.toThrow(/no larger than 256 KiB/u);
    } finally {
      await Promise.all([
        rm(directory, { recursive: true }),
        rm(outside, { recursive: true }),
      ]);
    }
  });
});
